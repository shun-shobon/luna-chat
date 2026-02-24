import { StreamableHTTPTransport } from "@hono/mcp";
import { serve, type ServerType } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { REST, Routes } from "discord.js";
import { Hono } from "hono";
import { z } from "zod";

type DiscordMessage = {
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
  id: string;
};

export type DiscordMcpServerHandle = {
  close: () => Promise<void>;
  url: string;
};

export type StartDiscordMcpServerOptions = {
  hostname?: string;
  port?: number;
  token: string;
};

const TOKEN_ENV_NAME = "DISCORD_BOT_TOKEN";
const DEFAULT_HISTORY_LIMIT = 30;
const MAX_HISTORY_LIMIT = 100;
const DISCORD_MCP_HOSTNAME = "127.0.0.1";
export const DISCORD_MCP_PATH = "/mcp";

const fetchHistoryInputSchema = z.object({
  beforeMessageId: z
    .string()
    .min(1)
    .optional()
    .describe("このメッセージIDより前の履歴を取得する。未指定時は最新から取得する。"),
  channelId: z.string().min(1).describe("履歴を取得するDiscordチャンネルID。"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_HISTORY_LIMIT)
    .optional()
    .describe(`取得件数。1〜${MAX_HISTORY_LIMIT}。未指定時は${DEFAULT_HISTORY_LIMIT}。`),
});

const sendReplyInputSchema = z.object({
  channelId: z.string().min(1).describe("送信先のDiscordチャンネルID。"),
  text: z.string().min(1).describe("チャンネルに投稿するメッセージ本文。"),
});

const discordApiMessageSchema = z.object({
  author: z.object({
    id: z.string(),
    username: z.string(),
  }),
  content: z.string(),
  id: z.string(),
  timestamp: z.string(),
});

export async function startDiscordMcpServer(
  options: StartDiscordMcpServerOptions,
): Promise<DiscordMcpServerHandle> {
  const token = options.token.trim();
  if (!token) {
    throw new Error(`${TOKEN_ENV_NAME} is required for discord MCP server.`);
  }

  const hostname = options.hostname ?? DISCORD_MCP_HOSTNAME;
  const port = options.port ?? 0;
  const rest = new REST({ version: "10" }).setToken(token);
  const mcpServer = createDiscordMcpToolServer(rest);
  const transport = new StreamableHTTPTransport();
  let connectPromise: Promise<void> | undefined;
  const app = new Hono();

  app.all(DISCORD_MCP_PATH, async (context) => {
    if (!mcpServer.isConnected()) {
      connectPromise ??= mcpServer.connect(transport);
      await connectPromise;
    }

    const response = await transport.handleRequest(context);
    return response ?? context.body(null, 204);
  });

  const started = await startServer({
    app,
    hostname,
    port,
  });

  return {
    close: async () => {
      await stopServer(started.server);
    },
    url: createDiscordMcpServerUrl(hostname, started.port),
  };
}

export function createDiscordMcpServerUrl(hostname: string, port: number): string {
  const formattedHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `http://${formattedHost}:${port}${DISCORD_MCP_PATH}`;
}

function createDiscordMcpToolServer(rest: REST): McpServer {
  const server = new McpServer({
    name: "luna-discord-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "fetch_discord_history",
    {
      description: "Discordチャンネルの履歴メッセージを取得する。",
      inputSchema: fetchHistoryInputSchema,
      title: "Discord履歴取得",
    },
    async ({ beforeMessageId, channelId, limit }) => {
      const boundedLimit = Math.min(limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
      const query = new URLSearchParams();
      query.set("limit", String(boundedLimit));
      if (beforeMessageId) {
        query.set("before", beforeMessageId);
      }

      const rawMessages = await rest.get(Routes.channelMessages(channelId), {
        query,
      });
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
      description: "Discordチャンネルへメッセージを送信する。",
      inputSchema: sendReplyInputSchema,
      title: "Discord送信",
    },
    async ({ channelId, text }) => {
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

  return server;
}

async function startServer(input: {
  app: Hono;
  hostname: string;
  port: number;
}): Promise<{ port: number; server: ServerType }> {
  return await new Promise((resolve, reject) => {
    let resolved = false;
    const server = serve(
      {
        fetch: input.app.fetch,
        hostname: input.hostname,
        port: input.port,
      },
      (info) => {
        resolved = true;
        resolve({
          port: info.port,
          server,
        });
      },
    );

    server.on("error", (error) => {
      if (!resolved) {
        reject(error);
      }
    });
  });
}

async function stopServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function parseDiscordMessages(rawMessages: unknown): DiscordMessage[] {
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  const messages: DiscordMessage[] = [];
  for (const rawMessage of rawMessages) {
    const parsed = discordApiMessageSchema.safeParse(rawMessage);
    if (!parsed.success) {
      continue;
    }
    const message = parsed.data;

    messages.push({
      authorId: message.author.id,
      authorName: message.author.username,
      content: message.content,
      createdAt: message.timestamp,
      id: message.id,
    });
  }

  return messages;
}
