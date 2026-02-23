#!/usr/bin/env -S node --enable-source-maps

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createConsola } from "consola";
import { Client, GatewayIntentBits } from "discord.js";

import { CodexAppServerAiService } from "./ai/ai-service";
import { resolveAiReplyWithHistoryLoop } from "./ai/reply-orchestrator";
import { loadRuntimeConfig, type RuntimeConfig } from "./config/runtime-config";
import { fetchConversationContext, toRuntimeMessage } from "./context/discord-context";
import { evaluateReplyPolicy } from "./policy/reply-policy";

const consola = createConsola();
const runtimeConfig = loadConfigOrExit();
const aiService = new CodexAppServerAiService(runtimeConfig.codexAppServerCommand);
const operationRulesDoc = loadOperationRulesDoc();
const DEFAULT_APOLOGY_MESSAGE = "ごめんね、今ちょっと不調みたい。少し待ってくれる？";

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
  if (message.author.bot) return;
  if (!client.user) return;
  const botUser = client.user;

  const policyDecision = evaluateReplyPolicy({
    allowedChannelIds: runtimeConfig.allowedChannelIds,
    channelId: message.channelId,
    isDm: !message.inGuild(),
    isThread: message.channel.isThread(),
    mentionedBot: message.mentions.has(botUser.id),
  });
  if (!policyDecision.shouldHandle) return;

  const currentMessage = toRuntimeMessage(message, botUser.id);

  try {
    const initialContext = await fetchConversationContext({
      botUserId: botUser.id,
      channel: message.channel,
      limit: runtimeConfig.contextFetchLimit,
      requestedByToolUse: false,
    });

    const aiDecision = await resolveAiReplyWithHistoryLoop({
      aiService,
      currentMessage,
      fetchMoreHistory: async (beforeMessageId) => {
        return fetchConversationContext({
          beforeMessageId,
          botUserId: botUser.id,
          channel: message.channel,
          limit: runtimeConfig.contextFetchLimit,
          requestedByToolUse: true,
        });
      },
      forceReply: policyDecision.forceReply,
      initialContext,
      logger: consola,
      operationRulesDoc,
    });
    if (!aiDecision.shouldReply) return;

    await message.reply(aiDecision.replyText).catch((error: unknown) => {
      consola.error("Failed to reply:", error);
    });
  } catch (error: unknown) {
    consola.error("Failed to generate AI reply:", error);
    if (!policyDecision.forceReply) return;

    await message.reply(DEFAULT_APOLOGY_MESSAGE).catch((replyError: unknown) => {
      consola.error("Failed to send fallback apology message:", replyError);
    });
  }
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

function loadOperationRulesDoc(): string {
  const runbookPath = resolve(process.cwd(), "docs/RUNBOOK.md");
  return readFileSync(runbookPath, "utf8");
}
