#!/usr/bin/env -S node --enable-source-maps

import { createConsola } from "consola";
import { Client, GatewayIntentBits } from "discord.js";

import { CodexAppServerAiService, type CodexAppServerAiServiceOptions } from "./ai/ai-service";
import { readApologyTemplate } from "./ai/apology-template";
import { loadRuntimeConfig, type RuntimeConfig } from "./config/runtime-config";
import { handleMessageCreate } from "./discord/message-handler";

const FIXED_CONTEXT_FETCH_LIMIT = 30;
const FIXED_CODEX_APP_SERVER_COMMAND = "codex app-server --listen stdio://";
const FIXED_CODEX_APP_SERVER_MODEL = "gpt-5.3-codex";
const FIXED_CODEX_APP_SERVER_APPROVAL_POLICY = "never";
const FIXED_CODEX_APP_SERVER_SANDBOX = "workspace-write";
const FIXED_CODEX_APP_SERVER_TIMEOUT_MS = 60_000;

const consola = createConsola({
  level: 4,
});
const runtimeConfig = loadConfigOrExit();
const aiServiceOptions: CodexAppServerAiServiceOptions = {
  approvalPolicy: FIXED_CODEX_APP_SERVER_APPROVAL_POLICY,
  command: FIXED_CODEX_APP_SERVER_COMMAND,
  cwd: runtimeConfig.codexWorkspaceDir,
  debugLog: (message, details) => {
    if (details) {
      consola.debug(message, details);
      return;
    }
    consola.debug(message);
  },
  model: FIXED_CODEX_APP_SERVER_MODEL,
  sandbox: FIXED_CODEX_APP_SERVER_SANDBOX,
  timeoutMs: FIXED_CODEX_APP_SERVER_TIMEOUT_MS,
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
  consola.info("Bot is ready!");
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
    contextFetchLimit: FIXED_CONTEXT_FETCH_LIMIT,
    logger: consola,
    message,
  }).catch((error: unknown) => {
    consola.error("Unexpected handler failure:", error);
  });
});

await client.login(runtimeConfig.discordBotToken).catch((error: unknown) => {
  consola.error("Failed to login:", error);
});

function loadConfigOrExit(): RuntimeConfig {
  try {
    return loadRuntimeConfig();
  } catch (error: unknown) {
    consola.error("Invalid configuration:", error);
    process.exit(1);
  }
}
