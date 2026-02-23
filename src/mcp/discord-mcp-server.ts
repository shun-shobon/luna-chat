import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { REST, Routes } from "discord.js";
import { z } from "zod";

type DiscordMessage = {
  id: string;
  content: string;
  createdAt: string;
  authorId: string;
  authorName: string;
};

const TOKEN_ENV_NAME = "DISCORD_BOT_TOKEN";
const DEFAULT_HISTORY_LIMIT = 30;
const MAX_HISTORY_LIMIT = 100;

const fetchHistoryInputSchema = z.object({
  beforeMessageId: z.string().min(1).optional(),
  channelId: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_HISTORY_LIMIT).optional(),
});

const sendReplyInputSchema = z.object({
  channelId: z.string().min(1),
  replyToMessageId: z.string().min(1),
  text: z.string().min(1),
});

await main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

async function main(): Promise<void> {
  const token = process.env[TOKEN_ENV_NAME]?.trim();
  if (!token) {
    throw new Error(`${TOKEN_ENV_NAME} is required for discord MCP server.`);
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const server = new McpServer({
    name: "luna-discord-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "fetch_discord_history",
    {
      description:
        "Fetch Discord channel messages. Use this when you need older conversation context.",
      inputSchema: fetchHistoryInputSchema,
      title: "Fetch Discord History",
    },
    async ({ beforeMessageId, channelId, limit }) => {
      const boundedLimit = Math.min(limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
      const query = new URLSearchParams();
      query.set("limit", String(boundedLimit));
      if (beforeMessageId) {
        query.set("before", beforeMessageId);
      }

      const rawMessages = (await rest.get(Routes.channelMessages(channelId), {
        query,
      })) as unknown;
      const messages = parseDiscordMessages(rawMessages).reverse();

      const payload = {
        channelId,
        messages,
      };
      return {
        content: [{ text: JSON.stringify(payload), type: "text" }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    "send_discord_reply",
    {
      description:
        "Send a reply message to Discord. Always provide the original target message id.",
      inputSchema: sendReplyInputSchema,
      title: "Send Discord Reply",
    },
    async ({ channelId, replyToMessageId, text }) => {
      const trimmedText = text.trim();
      if (trimmedText.length === 0) {
        throw new Error("text must not be empty.");
      }

      await rest.post(Routes.channelMessages(channelId), {
        body: {
          allowed_mentions: {
            parse: [],
          },
          content: trimmedText,
          message_reference: {
            fail_if_not_exists: false,
            message_id: replyToMessageId,
          },
        },
      });

      const payload = {
        ok: true,
      };
      return {
        content: [{ text: JSON.stringify(payload), type: "text" }],
        structuredContent: payload,
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function parseDiscordMessages(rawMessages: unknown): DiscordMessage[] {
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  const messages: DiscordMessage[] = [];
  for (const rawMessage of rawMessages) {
    if (!rawMessage || typeof rawMessage !== "object") {
      continue;
    }
    const rawRecord = rawMessage as Record<string, unknown>;
    const id = rawRecord["id"];
    const content = rawRecord["content"];
    const timestamp = rawRecord["timestamp"];
    const author = rawRecord["author"];
    if (
      typeof id !== "string" ||
      typeof content !== "string" ||
      typeof timestamp !== "string" ||
      !author ||
      typeof author !== "object"
    ) {
      continue;
    }

    const authorRecord = author as Record<string, unknown>;
    const authorId = authorRecord["id"];
    const username = authorRecord["username"];
    if (typeof authorId !== "string" || typeof username !== "string") {
      continue;
    }

    messages.push({
      authorId,
      authorName: username,
      content,
      createdAt: timestamp,
      id,
    });
  }

  return messages;
}
