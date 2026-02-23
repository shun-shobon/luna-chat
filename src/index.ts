#!/usr/bin/env -S node --enable-source-maps

import { Client, GatewayIntentBits } from "discord.js";

import { CodexAppServerAiService, type CodexAppServerAiServiceOptions } from "./ai/ai-service";
import { readApologyTemplate } from "./ai/apology-template";
import type { ReasoningEffort } from "./ai/codex-generated/ReasoningEffort";
import { loadRuntimeConfig, type RuntimeConfig } from "./config/runtime-config";
import { handleMessageCreate } from "./discord/message-handler";
import { logger } from "./logger";

const CONTEXT_FETCH_LIMIT = 30;
const CODEX_APP_SERVER_COMMAND = "codex app-server --listen stdio://";
const CODEX_APP_SERVER_MODEL = "gpt-5.3-codex";
const CODEX_APP_SERVER_APPROVAL_POLICY = "never";
const CODEX_APP_SERVER_SANDBOX = "workspace-write";
const CODEX_APP_SERVER_TIMEOUT_MS = 60_000;
const CODEX_APP_SERVER_REASONING_EFFORT: ReasoningEffort = "medium";

const runtimeConfig = loadConfigOrExit();
const aiServiceOptions: CodexAppServerAiServiceOptions = {
  approvalPolicy: CODEX_APP_SERVER_APPROVAL_POLICY,
  command: CODEX_APP_SERVER_COMMAND,
  cwd: runtimeConfig.codexWorkspaceDir,
  model: CODEX_APP_SERVER_MODEL,
  reasoningEffort: CODEX_APP_SERVER_REASONING_EFFORT,
  sandbox: CODEX_APP_SERVER_SANDBOX,
  timeoutMs: CODEX_APP_SERVER_TIMEOUT_MS,
};
const aiService = new CodexAppServerAiService(aiServiceOptions);
const apologyMessage = readApologyTemplate();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
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
    aiService,
    allowedChannelIds: runtimeConfig.allowedChannelIds,
    apologyMessage,
    botUserId,
    contextFetchLimit: CONTEXT_FETCH_LIMIT,
    logger,
    message,
  }).catch((error: unknown) => {
    logger.error("Unexpected handler failure:", error);
  });
});

await client.login(runtimeConfig.discordBotToken).catch((error: unknown) => {
  logger.error("Failed to login:", error);
});

function loadConfigOrExit(): RuntimeConfig {
  try {
    return loadRuntimeConfig();
  } catch (error: unknown) {
    logger.error("Invalid configuration:", error);
    process.exit(1);
  }
}
