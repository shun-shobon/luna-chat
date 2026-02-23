#!/usr/bin/env -S node --enable-source-maps

import { createConsola } from "consola";
import { Client, GatewayIntentBits } from "discord.js";

import { hello } from "./hello";

const consola = createConsola();

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
  if (message.content.startsWith("!ping")) {
    await message.reply(hello());
  }
});

await client.login(process.env["DISCORD_BOT_TOKEN"]).catch((error) => {
  consola.error("Failed to login:", error);
});
