import { StreamableHTTPTransport } from "@hono/mcp";
import { serve, type ServerType } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { REST, Routes } from "discord.js";
import { Hono } from "hono";
import { z } from "zod";

import {
  appendAttachmentMarkersFromSources,
  type DiscordAttachmentInput,
  type DiscordAttachmentStore,
} from "../attachments/discord-attachment-store";
import { logger } from "../logger";

type DiscordMessage = {
  attachments: DiscordAttachmentInput[];
  authorId: string;
  authorIsBot: boolean;
  authorName: string;
  content: string;
  createdAt: string;
  id: string;
};

export type DiscordMcpServerHandle = {
  close: () => Promise<void>;
  stopTypingByChannelId: (channelId: string) => void;
  url: string;
};

export type StartDiscordMcpServerOptions = {
  attachmentStore: DiscordAttachmentStore;
  hostname?: string;
  port?: number;
  token: string;
};

const TOKEN_ENV_NAME = "DISCORD_BOT_TOKEN";
const DEFAULT_HISTORY_LIMIT = 30;
const MAX_HISTORY_LIMIT = 100;
const TYPING_INTERVAL_MS = 8_000;
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
  replyToMessageId: z
    .string()
    .min(1)
    .optional()
    .describe("返信先メッセージID。指定した場合は返信として投稿する。"),
  text: z.string().min(1).describe("チャンネルに投稿するメッセージ本文。"),
});

const addReactionInputSchema = z.object({
  channelId: z.string().min(1).describe("リアクション対象メッセージのチャンネルID。"),
  messageId: z.string().min(1).describe("リアクション対象のメッセージID。"),
  emoji: z
    .string()
    .min(1)
    .describe("付与する絵文字。Unicodeまたはカスタム絵文字（name:id）を指定する。"),
});

const startTypingInputSchema = z.object({
  channelId: z.string().min(1).describe("入力中表示を開始するDiscordチャンネルID。"),
});

const discordApiAttachmentSchema = z.object({
  filename: z.string(),
  id: z.string(),
  url: z.string(),
});

const discordApiMessageSchema = z.object({
  attachments: z.array(discordApiAttachmentSchema).optional().default([]),
  author: z.object({
    bot: z.boolean().optional().default(false),
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
  const typingLoopController = createTypingLoopController(rest);
  const mcpServer = createDiscordMcpToolServer({
    attachmentStore: options.attachmentStore,
    rest,
    typingLoopController,
  });
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
      typingLoopController.stopAllTyping();
      await stopServer(started.server);
    },
    stopTypingByChannelId: (channelId: string) => {
      typingLoopController.stopTypingByChannelId(channelId);
    },
    url: createDiscordMcpServerUrl(hostname, started.port),
  };
}

export function createDiscordMcpServerUrl(hostname: string, port: number): string {
  const formattedHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `http://${formattedHost}:${port}${DISCORD_MCP_PATH}`;
}

function createDiscordMcpToolServer(input: {
  attachmentStore: DiscordAttachmentStore;
  rest: REST;
  typingLoopController: TypingLoopController;
}): McpServer {
  const { attachmentStore, rest, typingLoopController } = input;
  const server = new McpServer({
    name: "luna-chat-discord-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "read_message_history",
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
      const parsedMessages = parseDiscordMessages(rawMessages).reverse();
      const messages = await Promise.all(
        parsedMessages.map(async (message) => {
          const content = await appendAttachmentMarkersFromSources({
            attachmentStore,
            attachments: message.attachments,
            channelId,
            content: message.content,
            logger,
            messageId: message.id,
          });
          return {
            authorId: message.authorId,
            authorIsBot: message.authorIsBot,
            authorName: formatAuthorLabel(message),
            content,
            createdAt: message.createdAt,
            id: message.id,
          };
        }),
      );

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
    "send_message",
    {
      description: "Discordチャンネルへメッセージを送信する。",
      inputSchema: sendReplyInputSchema,
      title: "Discord送信",
    },
    async ({ channelId, replyToMessageId, text }) => {
      const payload = await sendMessage(rest, {
        channelId,
        text,
        ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
      });
      return {
        content: [{ text: JSON.stringify(payload), type: "text" }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    "add_reaction",
    {
      description: "Discordメッセージへリアクションを付与する。",
      inputSchema: addReactionInputSchema,
      title: "Discordリアクション追加",
    },
    async ({ channelId, emoji, messageId }) => {
      const payload = await addMessageReaction(rest, {
        channelId,
        emoji,
        messageId,
      });
      return {
        content: [{ text: JSON.stringify(payload), type: "text" }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    "start_typing",
    {
      description: "Discordチャンネルの入力中表示を開始する。turn 完了時に自動停止される。",
      inputSchema: startTypingInputSchema,
      title: "Discord入力中表示開始",
    },
    async ({ channelId }) => {
      const payload = await typingLoopController.startTypingByChannelId(channelId);
      return {
        content: [{ text: JSON.stringify(payload), type: "text" }],
        structuredContent: payload,
      };
    },
  );

  return server;
}

type TypingLoopController = {
  startTypingByChannelId: (channelId: string) => Promise<{ alreadyRunning: boolean; ok: true }>;
  stopTypingByChannelId: (channelId: string) => void;
  stopAllTyping: () => void;
};

type StartTypingLoopInput = {
  activeTypingLoops: Map<string, ReturnType<typeof setInterval>>;
  channelId: string;
  rest: Pick<REST, "post">;
  setIntervalFn?: typeof setInterval;
};

type StopTypingLoopInput = {
  activeTypingLoops: Map<string, ReturnType<typeof setInterval>>;
  channelId: string;
  clearIntervalFn?: typeof clearInterval;
};

export async function startTypingLoop(
  input: StartTypingLoopInput,
): Promise<{ alreadyRunning: boolean; ok: true }> {
  if (input.activeTypingLoops.has(input.channelId)) {
    return {
      alreadyRunning: true,
      ok: true,
    };
  }

  await sendTypingIndicator(input.rest, input.channelId);

  const setIntervalFn = input.setIntervalFn ?? setInterval;
  const interval = setIntervalFn(() => {
    void sendTypingIndicator(input.rest, input.channelId).catch((error: unknown) => {
      logger.warn("Failed to send typing indicator via MCP:", error);
    });
  }, TYPING_INTERVAL_MS);

  input.activeTypingLoops.set(input.channelId, interval);
  return {
    alreadyRunning: false,
    ok: true,
  };
}

export function stopTypingLoop(input: StopTypingLoopInput): void {
  const activeInterval = input.activeTypingLoops.get(input.channelId);
  if (!activeInterval) {
    return;
  }

  const clearIntervalFn = input.clearIntervalFn ?? clearInterval;
  clearIntervalFn(activeInterval);
  input.activeTypingLoops.delete(input.channelId);
}

export function stopAllTypingLoops(input: {
  activeTypingLoops: Map<string, ReturnType<typeof setInterval>>;
  clearIntervalFn?: typeof clearInterval;
}): void {
  for (const channelId of input.activeTypingLoops.keys()) {
    if (input.clearIntervalFn) {
      stopTypingLoop({
        activeTypingLoops: input.activeTypingLoops,
        channelId,
        clearIntervalFn: input.clearIntervalFn,
      });
      continue;
    }

    stopTypingLoop({
      activeTypingLoops: input.activeTypingLoops,
      channelId,
    });
  }
}

type MessageReactionInput = {
  channelId: string;
  emoji: string;
  messageId: string;
};

type SendMessageInput = {
  channelId: string;
  replyToMessageId?: string;
  text: string;
};

export async function sendMessage(
  rest: Pick<REST, "post">,
  input: SendMessageInput,
): Promise<{ ok: true }> {
  const trimmedText = input.text.trim();
  if (trimmedText.length === 0) {
    throw new Error("text must not be empty.");
  }

  const trimmedReplyToMessageId = input.replyToMessageId?.trim();
  if (input.replyToMessageId !== undefined && !trimmedReplyToMessageId) {
    throw new Error("replyToMessageId must not be empty.");
  }

  await rest.post(Routes.channelMessages(input.channelId), {
    body: {
      allowed_mentions: {
        parse: [],
        ...(trimmedReplyToMessageId ? { replied_user: true } : {}),
      },
      content: trimmedText,
      ...(trimmedReplyToMessageId
        ? {
            message_reference: {
              fail_if_not_exists: false,
              message_id: trimmedReplyToMessageId,
            },
          }
        : {}),
    },
  });

  return {
    ok: true,
  };
}

export async function addMessageReaction(
  rest: Pick<REST, "put">,
  input: MessageReactionInput,
): Promise<{ ok: true }> {
  const trimmedEmoji = input.emoji.trim();
  if (trimmedEmoji.length === 0) {
    throw new Error("emoji must not be empty.");
  }

  await rest.put(Routes.channelMessageOwnReaction(input.channelId, input.messageId, trimmedEmoji));

  return {
    ok: true,
  };
}

function createTypingLoopController(rest: Pick<REST, "post">): TypingLoopController {
  const activeTypingLoops = new Map<string, ReturnType<typeof setInterval>>();

  return {
    startTypingByChannelId: async (channelId) => {
      return await startTypingLoop({
        activeTypingLoops,
        channelId,
        rest,
      });
    },
    stopAllTyping: () => {
      stopAllTypingLoops({
        activeTypingLoops,
      });
    },
    stopTypingByChannelId: (channelId) => {
      stopTypingLoop({
        activeTypingLoops,
        channelId,
      });
    },
  };
}

async function sendTypingIndicator(rest: Pick<REST, "post">, channelId: string): Promise<void> {
  await rest.post(Routes.channelTyping(channelId));
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
      attachments: message.attachments.map((attachment) => {
        return {
          id: attachment.id,
          name: attachment.filename,
          url: attachment.url,
        };
      }),
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      authorName: message.author.username,
      content: message.content,
      createdAt: message.timestamp,
      id: message.id,
    });
  }

  return messages;
}

function formatAuthorLabel(
  message: Pick<DiscordMessage, "authorId" | "authorIsBot" | "authorName">,
): string {
  const botSuffix = message.authorIsBot ? " (Bot)" : "";
  return `${message.authorName}${botSuffix} (ID: ${message.authorId})`;
}
