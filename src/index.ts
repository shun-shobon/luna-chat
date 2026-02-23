#!/usr/bin/env -S node --enable-source-maps

import { createConsola } from "consola";
import { Client, GatewayIntentBits } from "discord.js";

import { CodexAppServerAiService, type CodexAppServerAiServiceOptions } from "./ai/ai-service";
import { readApologyTemplate } from "./ai/apology-template";
import { loadRuntimeConfig, type RuntimeConfig } from "./config/runtime-config";
import { fetchConversationContext } from "./context/discord-context";
import { handleMessageCreate } from "./discord/message-handler";

const consola = createConsola({
  level: 4,
});
const runtimeConfig = loadConfigOrExit();
const aiServiceOptions: CodexAppServerAiServiceOptions = {
  approvalPolicy: runtimeConfig.codexAppServerApprovalPolicy,
  command: runtimeConfig.codexAppServerCommand,
  cwd: runtimeConfig.codexAppServerCwd,
  debugLog: (message, details) => {
    if (details) {
      consola.debug(message, details);
      return;
    }
    consola.debug(message);
  },
  model: runtimeConfig.codexAppServerModel,
  sandbox: runtimeConfig.codexAppServerSandbox,
  timeoutMs: runtimeConfig.codexAppServerTimeoutMs,
};
const aiService = new CodexAppServerAiService(aiServiceOptions);
const apologyMessage = readApologyTemplate(runtimeConfig.apologyTemplatePath);

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
    contextFetchLimit: runtimeConfig.contextFetchLimit,
    fetchConversationContext: async ({ beforeMessageId, limit, requestedByToolUse }) => {
      const baseFetchInput = {
        botUserId,
        channel: message.channel,
        limit,
        requestedByToolUse,
      };
      if (beforeMessageId) {
        return fetchConversationContext({
          ...baseFetchInput,
          beforeMessageId,
        });
      }
      return fetchConversationContext(baseFetchInput);
    },
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
