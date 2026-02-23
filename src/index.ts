import { createConsola } from "consola";
import { Client, GatewayIntentBits } from "discord.js";

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
    await message.reply("Pong!");
  }
});

await client.login(process.env["DISCORD_BOT_TOKEN"]).catch((error) => {
  consola.error("Failed to login:", error);
});
