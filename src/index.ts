#!/usr/bin/env -S node --enable-source-maps

import { Client, GatewayIntentBits, Partials } from "discord.js";

import { CodexAiRuntime } from "./modules/ai/adapters/outbound/codex/codex-ai-runtime";
import { ChannelSessionCoordinator } from "./modules/ai/application/channel-session-coordinator";
import {
  handleMessageCreate,
  handleTypingStart,
} from "./modules/conversation/adapters/inbound/discord-message-create-handler";
import { createDiscordAiDispatcher } from "./modules/conversation/application/discord-ai-dispatcher";
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
const CODEX_APP_SERVER_TIMEOUT_MS_FOR_DISCORD = 10 * 60_000;
const CODEX_APP_SERVER_TIMEOUT_MS_FOR_HEARTBEAT = 30 * 60_000;
const HEARTBEAT_PROMPT =
  "`HEARTBEAT.md`がワークスペース内に存在する場合はそれを確認し、内容に従って作業を行ってください。過去のチャットで言及された古いタスクを推測したり繰り返してはいけません。特に対応すべき事項がない場合は、そのまま終了してください。";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageTyping,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const runtimeConfig = await loadConfigOrExit();
client.rest.setToken(runtimeConfig.discordBotToken);
await initializeFileLoggingOrExit(runtimeConfig.logsDir);
const typingLifecycleRegistry = createTypingLifecycleRegistry();
const discordMcpServer = await startDiscordMcpServerOrExit(
  runtimeConfig.allowedChannelIds,
  client,
  typingLifecycleRegistry,
  runtimeConfig.codexWorkspaceDir,
);

client.on("clientReady", () => {
  logger.info("Bot is ready!");
});

await client.login(runtimeConfig.discordBotToken).catch(async (error: unknown) => {
  logger.error("Failed to login:", error);
  await closeDiscordMcpServer(discordMcpServer);
  await closeFileLogging();
  process.exit(1);
});

const botUserId = client.user?.id;
if (!botUserId) {
  logger.error("Bot user is unavailable after login.");
  await client.destroy();
  await closeDiscordMcpServer(discordMcpServer);
  await closeFileLogging();
  process.exit(1);
}

const aiService = new ChannelSessionCoordinator({
  createRuntime: () =>
    new CodexAiRuntime({
      codexHomeDir: runtimeConfig.codexHomeDir,
      command: CODEX_APP_SERVER_COMMAND,
      cwd: runtimeConfig.codexWorkspaceDir,
    }),
  discordTurnTimeoutMs: CODEX_APP_SERVER_TIMEOUT_MS_FOR_DISCORD,
  discordMcpServerUrl: discordMcpServer.url,
  heartbeatTurnTimeoutMs: CODEX_APP_SERVER_TIMEOUT_MS_FOR_HEARTBEAT,
  onDiscordTurnCompleted: (channelIds) => {
    for (const channelId of channelIds) {
      typingLifecycleRegistry.stopByChannelId(channelId);
    }
  },
  botUserId,
  workspaceDir: runtimeConfig.codexWorkspaceDir,
});

await aiService.initializeRuntime().catch(async (error: unknown) => {
  logger.error("Failed to initialize Codex app-server runtime:", error);
  await client.destroy();
  await closeDiscordMcpServer(discordMcpServer);
  await closeFileLogging();
  process.exit(1);
});

const discordAiDispatcher = createDiscordAiDispatcher({
  aiService,
  dispatchDelayMs: runtimeConfig.aiDispatchDelayMs,
  logger,
  typingIdleTimeoutMs: runtimeConfig.typingIdleTimeoutMs,
  typingLifecycleRegistry,
});

const heartbeatRunner = startHeartbeatRunner({
  aiService,
  cronTime: runtimeConfig.heartbeatCronTime,
  logger,
  prompt: HEARTBEAT_PROMPT,
  timeZone: runtimeConfig.timeZone,
});
const cronPromptScheduler = await startCronPromptScheduler({
  aiService,
  logger,
  timeZone: runtimeConfig.timeZone,
  workspaceDir: runtimeConfig.codexWorkspaceDir,
}).catch(async (error: unknown) => {
  logger.error("Failed to start cron prompt scheduler:", error);
  heartbeatRunner.stop();
  await client.destroy();
  await closeDiscordMcpServer(discordMcpServer);
  await aiService.close();
  await closeFileLogging();
  process.exit(1);
});

client.on("messageCreate", async (message) => {
  await handleMessageCreate({
    allowedChannelIds: runtimeConfig.allowedChannelIds,
    allowDm: runtimeConfig.allowDm,
    botUserId,
    logger,
    message,
    messageDispatcher: discordAiDispatcher,
  }).catch((error: unknown) => {
    logger.error("Unexpected handler failure:", error);
  });
});

client.on("typingStart", (typing) => {
  handleTypingStart({
    allowedChannelIds: runtimeConfig.allowedChannelIds,
    allowDm: runtimeConfig.allowDm,
    botUserId,
    messageDispatcher: discordAiDispatcher,
    typing,
  });
});

registerShutdownHooks({
  client,
  cronPromptScheduler,
  discordAiDispatcher,
  discordMcpServer,
  heartbeatRunner,
  aiService,
  typingLifecycleRegistry,
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
  client: Client,
  typingRegistry: ReturnType<typeof createTypingLifecycleRegistry>,
  workspaceDir: string,
): Promise<DiscordMcpServerHandle> {
  try {
    const mcpServer = await startDiscordMcpServer({
      allowedChannelIds,
      client,
      typingLifecycleRegistry: typingRegistry,
      workspaceDir,
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
  discordAiDispatcher: ReturnType<typeof createDiscordAiDispatcher>;
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
    input.discordAiDispatcher.dispose();
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
