#!/usr/bin/env -S node --enable-source-maps

import { Client, GatewayIntentBits } from "discord.js";

import type { ReasoningEffort } from "./ai/codex-generated/ReasoningEffort";
import {
  WorkspaceDiscordAttachmentStore,
  type DiscordAttachmentStore,
} from "./attachments/discord-attachment-store";
import { CodexAiRuntime } from "./modules/ai/adapters/outbound/codex/codex-ai-runtime";
import { ChannelSessionCoordinator } from "./modules/ai/application/channel-session-coordinator";
import {
  handleMessageCreate,
  type ReplyGenerator,
} from "./modules/conversation/adapters/inbound/discord-message-create-handler";
import {
  startHeartbeatRunner,
  type HeartbeatRunnerHandle,
} from "./modules/heartbeat/heartbeat-runner";
import {
  type DiscordMcpServerHandle,
  startDiscordMcpServer,
} from "./modules/mcp/inbound/discord-mcp-http-server";
import { type RuntimeConfig, loadRuntimeConfig } from "./modules/runtime-config/runtime-config";
import { createTypingLifecycleRegistry } from "./modules/typing/typing-lifecycle-registry";
import { logger } from "./shared/logger";

const CODEX_APP_SERVER_COMMAND = ["codex", "app-server", "--listen", "stdio://"] as const;
const CODEX_APP_SERVER_MODEL = "gpt-5.3-codex";
const CODEX_APP_SERVER_APPROVAL_POLICY = "never";
const CODEX_APP_SERVER_SANDBOX = "workspace-write";
const CODEX_APP_SERVER_TIMEOUT_MS_FOR_DISCORD = 10 * 60_000;
const CODEX_APP_SERVER_TIMEOUT_MS_FOR_HEARTBEAT = 30 * 60_000;
const CODEX_APP_SERVER_REASONING_EFFORT: ReasoningEffort = "medium";
const HEARTBEAT_PROMPT =
  "`HEARTBEAT.md`がワークスペース内に存在する場合はそれを確認し、内容に従って作業を行ってください。過去のチャットで言及された古いタスクを推測したり繰り返してはいけません。特に対応すべき事項がない場合は、そのまま終了してください。";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const runtimeConfig = await loadConfigOrExit();
const typingLifecycleRegistry = createTypingLifecycleRegistry();
const attachmentStore = new WorkspaceDiscordAttachmentStore(runtimeConfig.codexWorkspaceDir);
const discordMcpServer = await startDiscordMcpServerOrExit(
  runtimeConfig.allowedChannelIds,
  runtimeConfig.discordBotToken,
  attachmentStore,
  typingLifecycleRegistry,
);

const createRuntime = (timeoutMs: number) => {
  return new CodexAiRuntime({
    approvalPolicy: CODEX_APP_SERVER_APPROVAL_POLICY,
    codexHomeDir: runtimeConfig.codexHomeDir,
    command: CODEX_APP_SERVER_COMMAND,
    cwd: runtimeConfig.codexWorkspaceDir,
    model: CODEX_APP_SERVER_MODEL,
    sandbox: CODEX_APP_SERVER_SANDBOX,
    timeoutMs,
  });
};

const discordAiService: ReplyGenerator = new ChannelSessionCoordinator({
  createRuntime: () => createRuntime(CODEX_APP_SERVER_TIMEOUT_MS_FOR_DISCORD),
  discordMcpServerUrl: discordMcpServer.url,
  onDiscordTurnCompleted: (channelId) => {
    typingLifecycleRegistry.stopByChannelId(channelId);
  },
  reasoningEffort: CODEX_APP_SERVER_REASONING_EFFORT,
  workspaceDir: runtimeConfig.codexWorkspaceDir,
});

const heartbeatAiService = new ChannelSessionCoordinator({
  createRuntime: () => createRuntime(CODEX_APP_SERVER_TIMEOUT_MS_FOR_HEARTBEAT),
  discordMcpServerUrl: discordMcpServer.url,
  reasoningEffort: CODEX_APP_SERVER_REASONING_EFFORT,
  workspaceDir: runtimeConfig.codexWorkspaceDir,
});

const heartbeatRunner = startHeartbeatRunner({
  aiService: heartbeatAiService,
  logger,
  prompt: HEARTBEAT_PROMPT,
});

registerShutdownHooks({
  client,
  discordMcpServer,
  heartbeatRunner,
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
    botUserId,
    logger,
    message,
    typingLifecycleRegistry,
  }).catch((error: unknown) => {
    logger.error("Unexpected handler failure:", error);
  });
});

await client.login(runtimeConfig.discordBotToken).catch((error: unknown) => {
  logger.error("Failed to login:", error);
  heartbeatRunner.stop();
  void closeDiscordMcpServer(discordMcpServer);
  process.exit(1);
});

async function loadConfigOrExit(): Promise<RuntimeConfig> {
  try {
    return await loadRuntimeConfig();
  } catch (error: unknown) {
    logger.error("Invalid configuration:", error);
    process.exit(1);
  }
}

async function startDiscordMcpServerOrExit(
  allowedChannelIds: ReadonlySet<string>,
  token: string,
  attachmentStore: DiscordAttachmentStore,
  typingRegistry: ReturnType<typeof createTypingLifecycleRegistry>,
): Promise<DiscordMcpServerHandle> {
  try {
    const mcpServer = await startDiscordMcpServer({
      allowedChannelIds,
      attachmentStore,
      token,
      typingLifecycleRegistry: typingRegistry,
    });
    logger.info("Discord MCP server started.", {
      url: mcpServer.url,
    });
    return mcpServer;
  } catch (error: unknown) {
    logger.error("Failed to start Discord MCP server:", error);
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
  discordMcpServer: DiscordMcpServerHandle;
  heartbeatRunner: HeartbeatRunnerHandle;
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
    input.heartbeatRunner.stop();
    input.typingLifecycleRegistry.stopAll();
    await input.client.destroy();
    await closeDiscordMcpServer(input.discordMcpServer);
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}
