import { StreamableHTTPTransport } from "@hono/mcp";
import { serve, type ServerType } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { REST, Routes } from "discord.js";
import { Hono } from "hono";
import { z } from "zod";

import type { DiscordAttachmentStore } from "../../../attachments/discord-attachment-store";
import { logger } from "../../../shared/logger";
import type { TypingLifecycleRegistry } from "../../typing/typing-lifecycle-registry";
import { createTypingLifecycleRegistry } from "../../typing/typing-lifecycle-registry";
import { createDiscordRestCommandGateway } from "../adapters/outbound/discord/discord-rest-command-gateway";
import {
  createDiscordRestHistoryGateway,
  parseDiscordMessages,
} from "../adapters/outbound/discord/discord-rest-history-gateway";
import { addReactionTool } from "../application/tools/add-reaction";
import { readMessageHistory } from "../application/tools/read-message-history";
import { sendMessageTool } from "../application/tools/send-message";
import { startTypingTool } from "../application/tools/start-typing";

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

export type DiscordMcpServerHandle = {
  close: () => Promise<void>;
  stopTypingByChannelId: (channelId: string) => void;
  url: string;
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

export type StartDiscordMcpServerOptions = {
  attachmentStore: DiscordAttachmentStore;
  hostname?: string;
  port?: number;
  token: string;
  typingLifecycleRegistry?: TypingLifecycleRegistry;
};

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
  const commandGateway = createDiscordRestCommandGateway(rest);
  const historyGateway = createDiscordRestHistoryGateway(rest);
  const typingRegistry = options.typingLifecycleRegistry ?? createTypingLifecycleRegistry();
  const mcpServer = new McpServer({
    name: "luna-chat-discord-mcp",
    version: "0.1.0",
  });

  mcpServer.registerTool(
    "read_message_history",
    {
      description: "Discordチャンネルの履歴メッセージを取得する。",
      inputSchema: fetchHistoryInputSchema,
      title: "Discord履歴取得",
    },
    async ({ beforeMessageId, channelId, limit }) => {
      const boundedLimit = Math.min(limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
      const payload = await readMessageHistory({
        channelId,
        ...(beforeMessageId === undefined ? {} : { beforeMessageId }),
        decorator: async (input) => {
          return await appendAttachmentMarkersFromSources({
            attachmentStore: options.attachmentStore,
            attachments: input.attachments,
            channelId: input.channelId,
            content: input.content,
            logger,
            messageId: input.messageId,
          });
        },
        gateway: historyGateway,
        limit: boundedLimit,
      });

      return {
        content: [{ text: JSON.stringify(payload), type: "text" }],
        structuredContent: payload,
      };
    },
  );

  mcpServer.registerTool(
    "send_message",
    {
      description: "Discordチャンネルへメッセージを送信する。",
      inputSchema: sendReplyInputSchema,
      title: "Discord送信",
    },
    async ({ channelId, replyToMessageId, text }) => {
      const payload = await sendMessageTool({
        channelId,
        gateway: commandGateway,
        text,
        ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
      });

      return {
        content: [{ text: JSON.stringify(payload), type: "text" }],
        structuredContent: payload,
      };
    },
  );

  mcpServer.registerTool(
    "add_reaction",
    {
      description: "Discordメッセージへリアクションを付与する。",
      inputSchema: addReactionInputSchema,
      title: "Discordリアクション追加",
    },
    async ({ channelId, emoji, messageId }) => {
      const payload = await addReactionTool({
        channelId,
        emoji,
        gateway: commandGateway,
        messageId,
      });

      return {
        content: [{ text: JSON.stringify(payload), type: "text" }],
        structuredContent: payload,
      };
    },
  );

  mcpServer.registerTool(
    "start_typing",
    {
      description: "Discordチャンネルの入力中表示を開始する。turn 完了時に自動停止される。",
      inputSchema: startTypingInputSchema,
      title: "Discord入力中表示開始",
    },
    async ({ channelId }) => {
      const payload = await startTypingTool({
        channelId,
        gateway: commandGateway,
        typingRegistry,
      });

      return {
        content: [{ text: JSON.stringify(payload), type: "text" }],
        structuredContent: payload,
      };
    },
  );

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
      typingRegistry.stopAll();
      await stopServer(started.server);
    },
    stopTypingByChannelId: (channelId) => {
      typingRegistry.stopByChannelId(channelId);
    },
    url: createDiscordMcpServerUrl(hostname, started.port),
  };
}

export function createDiscordMcpServerUrl(hostname: string, port: number): string {
  const formattedHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `http://${formattedHost}:${port}${DISCORD_MCP_PATH}`;
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

async function appendAttachmentMarkersFromSources(input: {
  attachmentStore: DiscordAttachmentStore;
  attachments: Array<{
    id: string;
    name: string | null;
    url: string;
  }>;
  channelId: string;
  content: string;
  logger: Pick<typeof logger, "warn">;
  messageId: string;
}): Promise<string> {
  const attachmentPaths: string[] = [];
  for (const attachment of input.attachments) {
    try {
      const savedPath = await input.attachmentStore.saveAttachment(attachment);
      attachmentPaths.push(savedPath);
    } catch (error: unknown) {
      input.logger.warn("Failed to save Discord attachment:", {
        attachmentId: attachment.id,
        channelId: input.channelId,
        error,
        messageId: input.messageId,
        url: attachment.url,
      });
    }
  }

  if (attachmentPaths.length === 0) {
    return input.content;
  }

  const markerLine = attachmentPaths.map((path) => `<attachment:${path}>`).join(" ");
  if (input.content.length === 0) {
    return markerLine;
  }

  return `${input.content}\n${markerLine}`;
}

export async function sendMessage(
  rest: Pick<REST, "post">,
  input: {
    channelId: string;
    replyToMessageId?: string;
    text: string;
  },
): Promise<{ ok: true }> {
  const commandGateway = createDiscordRestCommandGateway({
    post: rest.post.bind(rest),
    put: async () => {
      throw new Error("put is not supported in sendMessage.");
    },
  });

  return await commandGateway.sendMessage(input);
}

export async function addMessageReaction(
  rest: Pick<REST, "put">,
  input: {
    channelId: string;
    emoji: string;
    messageId: string;
  },
): Promise<{ ok: true }> {
  const commandGateway = createDiscordRestCommandGateway({
    post: async () => {
      throw new Error("post is not supported in addMessageReaction.");
    },
    put: rest.put.bind(rest),
  });

  return await commandGateway.addReaction(input);
}

export async function startTypingLoop(
  input: StartTypingLoopInput,
): Promise<{ alreadyRunning: boolean; ok: true }> {
  if (input.activeTypingLoops.has(input.channelId)) {
    return {
      alreadyRunning: true,
      ok: true,
    };
  }

  await input.rest.post(Routes.channelTyping(input.channelId));

  const setIntervalFn = input.setIntervalFn ?? setInterval;
  const interval = setIntervalFn(() => {
    void input.rest.post(Routes.channelTyping(input.channelId)).catch((error: unknown) => {
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

export { parseDiscordMessages };
