#!/usr/bin/env -S node --enable-source-maps

import { Client, GatewayIntentBits, Partials } from "discord.js";

import { CodexAiRuntime } from "./modules/ai/adapters/outbound/codex/codex-ai-runtime";
import { ChannelSessionCoordinator } from "./modules/ai/application/channel-session-coordinator";
import {
  WorkspaceDiscordAttachmentStore,
  type DiscordAttachmentStore,
} from "./modules/attachments";
import {
  handleMessageCreate,
  type ReplyGenerator,
} from "./modules/conversation/adapters/inbound/discord-message-create-handler";
import {
  startCronPromptScheduler,
  type CronPromptSchedulerHandle,
} from "./modules/heartbeat/cron-prompt-scheduler";
import {
  startHeartbeatRunner,
  type HeartbeatRunnerHandle,
} from "./modules/heartbeat/heartbeat-runner";
import {
  type DiscordMcpServerHandle,
  startDiscordMcpServer,
} from "./modules/mcp/inbound/discord-mcp-http-server";
import {
  type RuntimeConfig,
  RuntimeConfigError,
  loadRuntimeConfig,
} from "./modules/runtime-config/runtime-config";
import { createTypingLifecycleRegistry } from "./modules/typing/typing-lifecycle-registry";
import { closeFileLogging, initializeFileLogging, logger } from "./shared/logger";

const CODEX_APP_SERVER_COMMAND = ["codex", "app-server", "--listen", "stdio://"] as const;
const CODEX_APP_SERVER_APPROVAL_POLICY = "never";
const CODEX_APP_SERVER_SANDBOX = "workspace-write";
const CODEX_APP_SERVER_TIMEOUT_MS_FOR_DISCORD = 10 * 60_000;
const CODEX_APP_SERVER_TIMEOUT_MS_FOR_HEARTBEAT = 30 * 60_000;
const HEARTBEAT_PROMPT =
  "`HEARTBEAT.md`がワークスペース内に存在する場合はそれを確認し、内容に従って作業を行ってください。過去のチャットで言及された古いタスクを推測したり繰り返してはいけません。特に対応すべき事項がない場合は、そのまま終了してください。";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const runtimeConfig = await loadConfigOrExit();
client.rest.setToken(runtimeConfig.discordBotToken);
await initializeFileLoggingOrExit(runtimeConfig.logsDir);
const typingLifecycleRegistry = createTypingLifecycleRegistry();
const attachmentStore = new WorkspaceDiscordAttachmentStore(runtimeConfig.codexWorkspaceDir);
const discordMcpServer = await startDiscordMcpServerOrExit(
  runtimeConfig.allowedChannelIds,
  attachmentStore,
  client,
  typingLifecycleRegistry,
);

const aiService = new ChannelSessionCoordinator({
  createRuntime: () =>
    new CodexAiRuntime({
      approvalPolicy: CODEX_APP_SERVER_APPROVAL_POLICY,
      codexHomeDir: runtimeConfig.codexHomeDir,
      command: CODEX_APP_SERVER_COMMAND,
      cwd: runtimeConfig.codexWorkspaceDir,
      sandbox: CODEX_APP_SERVER_SANDBOX,
    }),
  discordTurnTimeoutMs: CODEX_APP_SERVER_TIMEOUT_MS_FOR_DISCORD,
  discordMcpServerUrl: discordMcpServer.url,
  heartbeatTurnTimeoutMs: CODEX_APP_SERVER_TIMEOUT_MS_FOR_HEARTBEAT,
  onDiscordTurnCompleted: (channelId) => {
    typingLifecycleRegistry.stopByChannelId(channelId);
  },
  workspaceDir: runtimeConfig.codexWorkspaceDir,
});

await aiService.initializeRuntime().catch(async (error: unknown) => {
  logger.error("Failed to initialize Codex app-server runtime:", error);
  await closeDiscordMcpServer(discordMcpServer);
  await closeFileLogging();
  process.exit(1);
});

const discordAiService: ReplyGenerator = aiService;

const heartbeatRunner = startHeartbeatRunner({
  aiService,
  cronTime: runtimeConfig.heartbeatCronTime,
  logger,
  prompt: HEARTBEAT_PROMPT,
  ...(runtimeConfig.timeZone === undefined ? {} : { timeZone: runtimeConfig.timeZone }),
});
const cronPromptScheduler = await startCronPromptScheduler({
  aiService,
  logger,
  ...(runtimeConfig.timeZone === undefined ? {} : { timeZone: runtimeConfig.timeZone }),
  workspaceDir: runtimeConfig.codexWorkspaceDir,
});

registerShutdownHooks({
  client,
  cronPromptScheduler,
  discordMcpServer,
  heartbeatRunner,
  aiService,
  typingLifecycleRegistry,
});

client.on("clientReady", () => {
  logger.info("Bot is ready!");
});

client.on("messageCreate", async (message) => {
  if (!client.user) {
    return;
  }
  const botUserId = client.user.id;

  await handleMessageCreate({
    attachmentStore,
    aiService: discordAiService,
    allowedChannelIds: runtimeConfig.allowedChannelIds,
    allowDm: runtimeConfig.allowDm,
    botUserId,
    logger,
    message,
    typingLifecycleRegistry,
  }).catch((error: unknown) => {
    logger.error("Unexpected handler failure:", error);
  });
});

await client.login(runtimeConfig.discordBotToken).catch(async (error: unknown) => {
  logger.error("Failed to login:", error);
  await cronPromptScheduler.stop();
  heartbeatRunner.stop();
  await closeDiscordMcpServer(discordMcpServer);
  await aiService.close();
  await closeFileLogging();
  process.exit(1);
});

async function loadConfigOrExit(): Promise<RuntimeConfig> {
  try {
    return await loadRuntimeConfig();
  } catch (error: unknown) {
    if (error instanceof RuntimeConfigError) {
      logger.error("Invalid configuration:", error.message);
      process.exit(1);
    }
    logger.error("Invalid configuration:", error);
    process.exit(1);
  }
}

async function initializeFileLoggingOrExit(logsDir: string): Promise<void> {
  try {
    const { logFilePath } = await initializeFileLogging({
      logsDir,
    });
    logger.info("File logging enabled.", {
      logFilePath,
    });
  } catch (error: unknown) {
    logger.error("Failed to initialize file logging:", error);
    process.exit(1);
  }
}

async function startDiscordMcpServerOrExit(
  allowedChannelIds: ReadonlySet<string>,
  attachmentStore: DiscordAttachmentStore,
  client: Client,
  typingRegistry: ReturnType<typeof createTypingLifecycleRegistry>,
): Promise<DiscordMcpServerHandle> {
  try {
    const mcpServer = await startDiscordMcpServer({
      allowedChannelIds,
      attachmentStore,
      client,
      typingLifecycleRegistry: typingRegistry,
    });
    logger.info("Discord MCP server started.", {
      url: mcpServer.url,
    });
    return mcpServer;
  } catch (error: unknown) {
    logger.error("Failed to start Discord MCP server:", error);
    await closeFileLogging();
    process.exit(1);
  }
}

async function closeDiscordMcpServer(discordMcpServer: DiscordMcpServerHandle): Promise<void> {
  await discordMcpServer.close().catch((error: unknown) => {
    logger.error("Failed to stop Discord MCP server:", error);
  });
}

function registerShutdownHooks(input: {
  client: Client;
  cronPromptScheduler: CronPromptSchedulerHandle;
  discordMcpServer: DiscordMcpServerHandle;
  heartbeatRunner: HeartbeatRunnerHandle;
  aiService: ChannelSessionCoordinator;
  typingLifecycleRegistry: ReturnType<typeof createTypingLifecycleRegistry>;
}): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("Shutting down.", {
      signal,
    });
    await input.cronPromptScheduler.stop();
    input.heartbeatRunner.stop();
    input.typingLifecycleRegistry.stopAll();
    await input.client.destroy();
    await closeDiscordMcpServer(input.discordMcpServer);
    await input.aiService.close();
    await closeFileLogging();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}
