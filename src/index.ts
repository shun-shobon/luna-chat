#!/usr/bin/env -S node --enable-source-maps

import { Client, GatewayIntentBits } from "discord.js";

import { CodexAppServerAiService, type CodexAppServerAiServiceOptions } from "./ai/ai-service";
import type { ReasoningEffort } from "./ai/codex-generated/ReasoningEffort";
import {
  type DiscordAttachmentStore,
  WorkspaceDiscordAttachmentStore,
} from "./attachments/discord-attachment-store";
import { loadRuntimeConfig, type RuntimeConfig } from "./config/runtime-config";
import { handleMessageCreate } from "./discord/message-handler";
import { startHeartbeatRunner, type HeartbeatRunnerHandle } from "./heartbeat/heartbeat-runner";
import { logger } from "./logger";
import { startDiscordMcpServer, type DiscordMcpServerHandle } from "./mcp/discord-mcp-server";

const CODEX_APP_SERVER_COMMAND = ["codex", "app-server", "--listen", "stdio://"] as const;
const CODEX_APP_SERVER_MODEL = "gpt-5.3-codex";
const CODEX_APP_SERVER_APPROVAL_POLICY = "never";
const CODEX_APP_SERVER_SANDBOX = "workspace-write";
const CODEX_APP_SERVER_TIMEOUT_MS = 60_000;
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
const attachmentStore = new WorkspaceDiscordAttachmentStore(runtimeConfig.codexWorkspaceDir);
const discordMcpServer = await startDiscordMcpServerOrExit(
  runtimeConfig.discordBotToken,
  attachmentStore,
);
const aiServiceOptions: CodexAppServerAiServiceOptions = {
  approvalPolicy: CODEX_APP_SERVER_APPROVAL_POLICY,
  command: CODEX_APP_SERVER_COMMAND,
  codexHomeDir: runtimeConfig.codexHomeDir,
  cwd: runtimeConfig.codexWorkspaceDir,
  discordMcpServerUrl: discordMcpServer.url,
  model: CODEX_APP_SERVER_MODEL,
  reasoningEffort: CODEX_APP_SERVER_REASONING_EFFORT,
  sandbox: CODEX_APP_SERVER_SANDBOX,
  timeoutMs: CODEX_APP_SERVER_TIMEOUT_MS,
};
const aiService = new CodexAppServerAiService(aiServiceOptions);
const heartbeatRunner = startHeartbeatRunner({
  aiService,
  logger,
  prompt: HEARTBEAT_PROMPT,
});

registerShutdownHooks({
  client,
  discordMcpServer,
  heartbeatRunner,
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
    aiService,
    allowedChannelIds: runtimeConfig.allowedChannelIds,
    botUserId,
    logger,
    message,
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
  token: string,
  attachmentStore: DiscordAttachmentStore,
): Promise<DiscordMcpServerHandle> {
  try {
    const mcpServer = await startDiscordMcpServer({
      attachmentStore,
      token,
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
