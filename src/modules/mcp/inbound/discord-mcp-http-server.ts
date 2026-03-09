import { StreamableHTTPTransport } from "@hono/mcp";
import { serve, type ServerType } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { z } from "zod";

import { logger } from "../../../shared/logger";
import { appendAttachmentsToContent, type DiscordAttachmentStore } from "../../attachments";
import type { TypingLifecycleRegistry } from "../../typing/typing-lifecycle-registry";
import { createTypingLifecycleRegistry } from "../../typing/typing-lifecycle-registry";
import { createDiscordRestCommandGateway } from "../adapters/outbound/discord/discord-rest-command-gateway";
import { createDiscordRestHistoryGateway } from "../adapters/outbound/discord/discord-rest-history-gateway";
import { addReactionTool } from "../application/tools/add-reaction";
import { getUserDetailTool } from "../application/tools/get-user-detail";
import { listChannelsTool } from "../application/tools/list-channels";
import { readMessageHistory } from "../application/tools/read-message-history";
import { sendMessageTool } from "../application/tools/send-message";
import { startTypingTool } from "../application/tools/start-typing";
import type { DiscordCommandTarget } from "../ports/outbound/discord-command-gateway-port";

import {
  formatAddReactionContent,
  formatGetUserDetailContent,
  formatListChannelsContent,
  formatReadMessageHistoryContent,
  formatSendMessageContent,
  formatStartTypingContent,
} from "./discord-mcp-response-text";
import { resolveDiscordSendFilePaths as resolveSendFilePaths } from "./resolve-discord-send-file-paths";

const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 50;
const DISCORD_MCP_HOSTNAME = "127.0.0.1";
const DISCORD_MCP_PATH = "/mcp";
const HISTORY_CURSOR_INPUT_ERROR_MESSAGE =
  "beforeMessageId / afterMessageId / aroundMessageId は同時に指定できません。";
const TARGET_INPUT_ERROR_MESSAGE = "channelId と userId のどちらか一方のみ指定してください。";
const SEND_MESSAGE_PAYLOAD_INPUT_ERROR_MESSAGE =
  "text または filePaths の少なくとも一方を指定してください。";

const fetchHistoryInputSchema = z
  .object({
    afterMessageId: z
      .string()
      .min(1)
      .optional()
      .describe("このメッセージIDより後の履歴を取得する。"),
    aroundMessageId: z
      .string()
      .min(1)
      .optional()
      .describe("このメッセージIDの前後を含む履歴を取得する。"),
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
  })
  .refine(hasExclusiveHistoryCursor, {
    message: HISTORY_CURSOR_INPUT_ERROR_MESSAGE,
  });

const sendReplyInputSchema = z
  .object({
    channelId: z.string().min(1).optional().describe("送信先のDiscordチャンネルID。"),
    filePaths: z
      .array(z.string().trim().min(1))
      .min(1)
      .optional()
      .describe(
        "Discord に添付するファイルパスの配列。絶対パスを直接指定でき、相対パスは AI ワークスペースから解決する。",
      ),
    userId: z.string().min(1).optional().describe("送信先ユーザーのDiscordユーザーID（DM）。"),
    replyToMessageId: z
      .string()
      .min(1)
      .optional()
      .describe("返信先メッセージID。指定した場合は返信として投稿する。"),
    text: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("チャンネルに投稿するメッセージ本文。省略時は添付ファイルのみ送信する。"),
  })
  .refine(hasExclusiveTarget, {
    message: TARGET_INPUT_ERROR_MESSAGE,
  })
  .refine(hasSendMessagePayload, {
    message: SEND_MESSAGE_PAYLOAD_INPUT_ERROR_MESSAGE,
  });

const addReactionInputSchema = z
  .object({
    channelId: z.string().min(1).optional().describe("リアクション対象メッセージのチャンネルID。"),
    userId: z
      .string()
      .min(1)
      .optional()
      .describe("リアクション対象メッセージがあるDM相手のDiscordユーザーID。"),
    messageId: z.string().min(1).describe("リアクション対象のメッセージID。"),
    emoji: z
      .string()
      .min(1)
      .describe("付与する絵文字。Unicodeまたはカスタム絵文字（name:id）を指定する。"),
  })
  .refine(hasExclusiveTarget, {
    message: TARGET_INPUT_ERROR_MESSAGE,
  });

const startTypingInputSchema = z
  .object({
    channelId: z.string().min(1).optional().describe("入力中表示を開始するDiscordチャンネルID。"),
    userId: z
      .string()
      .min(1)
      .optional()
      .describe("入力中表示を開始するDM相手のDiscordユーザーID。"),
  })
  .refine(hasExclusiveTarget, {
    message: TARGET_INPUT_ERROR_MESSAGE,
  });

const listChannelsInputSchema = z.object({});

const getUserDetailInputSchema = z.object({
  channelId: z.string().min(1).describe("ユーザー詳細を照会するDiscordチャンネルID。"),
  userId: z.string().min(1).describe("詳細を取得するDiscordユーザーID。"),
});

export type DiscordMcpServerHandle = {
  close: () => Promise<void>;
  stopTypingByChannelId: (channelId: string) => void;
  url: string;
};

type StartDiscordMcpServerOptions = {
  allowedChannelIds: ReadonlySet<string>;
  attachmentStore: DiscordAttachmentStore;
  client: DiscordMcpClient;
  hostname?: string;
  port?: number;
  typingLifecycleRegistry?: TypingLifecycleRegistry;
  workspaceDir: string;
};

type DiscordMcpClient = Parameters<typeof createDiscordRestCommandGateway>[0] &
  Parameters<typeof createDiscordRestHistoryGateway>[0];

export async function startDiscordMcpServer(
  options: StartDiscordMcpServerOptions,
): Promise<DiscordMcpServerHandle> {
  const hostname = options.hostname ?? DISCORD_MCP_HOSTNAME;
  const port = options.port ?? 0;
  const commandGateway = createDiscordRestCommandGateway(options.client);
  const historyGateway = createDiscordRestHistoryGateway(options.client);
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
    async ({ afterMessageId, aroundMessageId, beforeMessageId, channelId, limit }) => {
      const boundedLimit = Math.min(limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
      const payload = await readMessageHistory({
        afterMessageId,
        aroundMessageId,
        channelId,
        beforeMessageId,
        decorator: async (input) => {
          return await appendAttachmentsToContent({
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
        content: [{ text: formatReadMessageHistoryContent(payload), type: "text" }],
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
    async ({ channelId, filePaths, replyToMessageId, text, userId }) => {
      const resolvedFilePaths = await resolveSendFilePaths({
        filePaths,
        workspaceDir: options.workspaceDir,
      });
      await sendMessageTool({
        filePaths: resolvedFilePaths,
        gateway: commandGateway,
        target: toCommandTarget({
          channelId,
          userId,
        }),
        text,
        typingRegistry,
        replyToMessageId,
      });

      return {
        content: [
          {
            text: formatSendMessageContent({
              channelId,
              filePaths,
              replyToMessageId,
              userId,
            }),
            type: "text",
          },
        ],
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
    async ({ channelId, emoji, messageId, userId }) => {
      await addReactionTool({
        emoji,
        gateway: commandGateway,
        messageId,
        target: toCommandTarget({
          channelId,
          userId,
        }),
      });

      return {
        content: [
          {
            text: formatAddReactionContent({
              channelId,
              emoji,
              messageId,
              userId,
            }),
            type: "text",
          },
        ],
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
    async ({ channelId, userId }) => {
      const payload = await startTypingTool({
        gateway: commandGateway,
        target: toCommandTarget({
          channelId,
          userId,
        }),
        typingRegistry,
      });

      return {
        content: [
          {
            text: formatStartTypingContent({
              alreadyRunning: payload.alreadyRunning,
              channelId,
              userId,
            }),
            type: "text",
          },
        ],
      };
    },
  );

  mcpServer.registerTool(
    "list_channels",
    {
      description: "許可チャンネル一覧を取得する。",
      inputSchema: listChannelsInputSchema,
      title: "Discordチャンネル一覧取得",
    },
    async () => {
      const payload = await listChannelsTool({
        allowedChannelIds: options.allowedChannelIds,
        gateway: historyGateway,
      });

      return {
        content: [{ text: formatListChannelsContent(payload), type: "text" }],
      };
    },
  );

  mcpServer.registerTool(
    "get_user_detail",
    {
      description: "Discordユーザーの詳細情報を取得する。",
      inputSchema: getUserDetailInputSchema,
      title: "Discordユーザー詳細取得",
    },
    async ({ channelId, userId }) => {
      const payload = await getUserDetailTool({
        allowedChannelIds: options.allowedChannelIds,
        channelId,
        gateway: historyGateway,
        userId,
      });

      return {
        content: [{ text: formatGetUserDetailContent(payload), type: "text" }],
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

function hasExclusiveTarget(input: {
  channelId?: string | undefined;
  userId?: string | undefined;
}): boolean {
  return (input.channelId === undefined) !== (input.userId === undefined);
}

function hasSendMessagePayload(input: {
  filePaths?: readonly string[] | undefined;
  text?: string | undefined;
}): boolean {
  return input.text !== undefined || input.filePaths !== undefined;
}

function hasExclusiveHistoryCursor(input: {
  afterMessageId?: string | undefined;
  aroundMessageId?: string | undefined;
  beforeMessageId?: string | undefined;
}): boolean {
  const cursors = [input.beforeMessageId, input.afterMessageId, input.aroundMessageId].filter(
    (value) => value !== undefined,
  );
  return cursors.length <= 1;
}

function toCommandTarget(input: {
  channelId?: string | undefined;
  userId?: string | undefined;
}): DiscordCommandTarget {
  if (input.channelId !== undefined) {
    return {
      channelId: input.channelId,
    };
  }
  if (input.userId !== undefined) {
    return {
      userId: input.userId,
    };
  }

  throw new Error(TARGET_INPUT_ERROR_MESSAGE);
}

function createDiscordMcpServerUrl(hostname: string, port: number): string {
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
