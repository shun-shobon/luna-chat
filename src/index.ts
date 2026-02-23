#!/usr/bin/env -S node --enable-source-maps

import { createConsola } from "consola";
import { Client, GatewayIntentBits } from "discord.js";

import { StubAiService } from "./ai/ai-service";
import { loadRuntimeConfig } from "./config/runtime-config";
import { evaluateReplyPolicy } from "./policy/reply-policy";

const consola = createConsola();
const runtimeConfig = loadConfigOrExit();
const aiService = new StubAiService();

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

  const policyDecision = evaluateReplyPolicy({
    allowedChannelIds: runtimeConfig.allowedChannelIds,
    channelId: message.channelId,
    isDm: !message.inGuild(),
    isThread: message.channel.isThread(),
    mentionedBot: message.mentions.has(client.user.id),
  });
  if (!policyDecision.shouldHandle) return;

  const aiDecision = await aiService.decideReply({
    forceReply: policyDecision.forceReply,
    messageContent: message.content,
  });
  if (!aiDecision.shouldReply) return;

  await message.reply(aiDecision.replyText).catch((error: unknown) => {
    consola.error("Failed to reply:", error);
  });
});

await client.login(runtimeConfig.discordBotToken).catch((error: unknown) => {
  consola.error("Failed to login:", error);
});

function loadConfigOrExit() {
  try {
    return loadRuntimeConfig();
  } catch (error: unknown) {
    consola.error("Invalid configuration:", error);
    process.exit(1);
  }
}
