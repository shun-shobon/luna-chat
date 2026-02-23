#!/usr/bin/env -S node --enable-source-maps

import { Client, GatewayIntentBits } from "discord.js";

import { CodexAppServerAiService, type CodexAppServerAiServiceOptions } from "./ai/ai-service";
import { readApologyTemplate } from "./ai/apology-template";
import { loadRuntimeConfig, type RuntimeConfig } from "./config/runtime-config";
import { handleMessageCreate } from "./discord/message-handler";
import { logger } from "./logger";

const contextFetchLimit = 30;
const codexAppServerCommand = "codex app-server --listen stdio://";
const codexAppServerModel = "gpt-5.3-codex";
const codexAppServerApprovalPolicy = "never";
const codexAppServerSandbox = "workspace-write";
const codexAppServerTimeoutMs = 60_000;
const threadConfig = {
  model_reasoning_effort: "medium",
};

const runtimeConfig = loadConfigOrExit();
const aiServiceOptions: CodexAppServerAiServiceOptions = {
  approvalPolicy: codexAppServerApprovalPolicy,
  command: codexAppServerCommand,
  cwd: runtimeConfig.codexWorkspaceDir,
  model: codexAppServerModel,
  sandbox: codexAppServerSandbox,
  threadConfig,
  timeoutMs: codexAppServerTimeoutMs,
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
    contextFetchLimit,
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
