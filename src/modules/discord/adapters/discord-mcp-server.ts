import { AsyncLocalStorage } from "node:async_hooks";

import { StreamableHTTPTransport } from "@hono/mcp";
import { serve, type ServerType } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { z } from "zod";

import {
  discordActionSchema,
  discordEmojiSchema,
  discordTargetSchema,
  sendFileSchema,
  type DiscordAction,
} from "../domain/discord-action";
import { discordIdSchema } from "../domain/discord-id";
import type { DiscordActionPort, DiscordActionSuccess } from "../ports/discord-action-port";
import type { DiscordReadPort } from "../ports/discord-read-port";

const HOSTNAME = "127.0.0.1";
const MCP_PATH = "/mcp";
export const DISCORD_MCP_TYPING_OWNER_HEADER = "X-Luna-Typing-Owner";

const typingOwnerStorage = new AsyncLocalStorage<string | undefined>();

const historyInputSchema = z
  .strictObject({
    channelId: discordIdSchema,
    limit: z.number().int().min(1).max(100),
    beforeMessageId: discordIdSchema.optional(),
    afterMessageId: discordIdSchema.optional(),
    aroundMessageId: discordIdSchema.optional(),
  })
  .refine(
    (input) =>
      [input.beforeMessageId, input.afterMessageId, input.aroundMessageId].filter(
        (value) => value !== undefined,
      ).length <= 1,
    { message: "Only one Discord history cursor may be specified" },
  );
const emptyInputSchema = z.strictObject({});
const getUserInputSchema = z.strictObject({
  userId: discordIdSchema,
  guildId: discordIdSchema.optional(),
});
const listGuildEmojisInputSchema = z.strictObject({ guildId: discordIdSchema });
const getGuildEmojiInputSchema = z.strictObject({
  guildId: discordIdSchema,
  emojiId: discordIdSchema,
});
const sendMessageInputSchema = z.strictObject({
  target: discordTargetSchema,
  content: z.string().min(1).max(2_000).optional(),
  files: z.array(sendFileSchema).min(1).optional(),
});
const replyMessageInputSchema = z.strictObject({
  channelId: discordIdSchema,
  messageId: discordIdSchema,
  content: z.string().min(1).max(2_000).optional(),
  files: z.array(sendFileSchema).min(1).optional(),
});
const reactionInputSchema = z.strictObject({
  channelId: discordIdSchema,
  messageId: discordIdSchema,
  emoji: discordEmojiSchema,
});
const typingInputSchema = z.strictObject({ target: discordTargetSchema });

export type DiscordMcpServerHandle = Readonly<{
  url: string;
  close(): Promise<void>;
}>;

export async function startDiscordMcpServer(
  input: Readonly<{
    actions: DiscordActionPort;
    onError: (error: Error) => void;
    onEvent: (
      event: string,
      context: Readonly<{ actionIndex?: number; toolCallId: string }>,
      details: Readonly<Record<string, unknown>>,
      payload?: unknown,
    ) => void;
    read: DiscordReadPort;
  }>,
): Promise<DiscordMcpServerHandle> {
  const mcp = new McpServer({ name: "luna-discord", version: "1.0.0" });

  mcp.registerTool(
    "read_message_history",
    { description: "Discord message historyを読む", inputSchema: historyInputSchema },
    async (arguments_, extra) =>
      await runTool(input, "read_message_history", arguments_, extra.requestId, false, async () =>
        result(await input.read.readMessageHistory(arguments_)),
      ),
  );
  mcp.registerTool(
    "list_channels",
    { description: "到達可能なDiscord channelとthreadを列挙する", inputSchema: emptyInputSchema },
    async (arguments_, extra) =>
      await runTool(input, "list_channels", arguments_, extra.requestId, false, async () =>
        result(await input.read.listChannels()),
      ),
  );
  mcp.registerTool(
    "get_user_detail",
    { description: "Discord userと任意のGuild member詳細を読む", inputSchema: getUserInputSchema },
    async (arguments_, extra) =>
      await runTool(input, "get_user_detail", arguments_, extra.requestId, false, async () =>
        result(await input.read.getUserDetail(arguments_)),
      ),
  );
  mcp.registerTool(
    "list_guild_emojis",
    { description: "Guild emojiを列挙する", inputSchema: listGuildEmojisInputSchema },
    async (arguments_, extra) =>
      await runTool(input, "list_guild_emojis", arguments_, extra.requestId, false, async () =>
        result(await input.read.listGuildEmojis(arguments_.guildId)),
      ),
  );
  mcp.registerTool(
    "get_guild_emoji",
    { description: "Guild emojiの詳細を読む", inputSchema: getGuildEmojiInputSchema },
    async (arguments_, extra) =>
      await runTool(input, "get_guild_emoji", arguments_, extra.requestId, false, async () =>
        result(await input.read.getGuildEmoji(arguments_)),
      ),
  );

  mcp.registerTool(
    "send_message",
    { description: "Discord messageを送信する", inputSchema: sendMessageInputSchema },
    async (arguments_, extra) =>
      await runTool(input, "send_message", arguments_, extra.requestId, true, async () =>
        actionResult(await executeAction(input.actions, { kind: "send_message", ...arguments_ })),
      ),
  );
  mcp.registerTool(
    "reply_message",
    { description: "Discord messageへ返信する", inputSchema: replyMessageInputSchema },
    async (arguments_, extra) =>
      await runTool(input, "reply_message", arguments_, extra.requestId, true, async () =>
        actionResult(await executeAction(input.actions, { kind: "reply_message", ...arguments_ })),
      ),
  );
  mcp.registerTool(
    "add_reaction",
    { description: "Discord messageへreactionを追加する", inputSchema: reactionInputSchema },
    async (arguments_, extra) =>
      await runTool(input, "add_reaction", arguments_, extra.requestId, true, async () =>
        actionResult(await executeAction(input.actions, { kind: "add_reaction", ...arguments_ })),
      ),
  );
  mcp.registerTool(
    "remove_reaction",
    {
      description: "Discord messageからLunaのreactionを削除する",
      inputSchema: reactionInputSchema,
    },
    async (arguments_, extra) =>
      await runTool(input, "remove_reaction", arguments_, extra.requestId, true, async () =>
        actionResult(
          await executeAction(input.actions, { kind: "remove_reaction", ...arguments_ }),
        ),
      ),
  );
  mcp.registerTool(
    "start_typing",
    { description: "Discord typing表示を開始する", inputSchema: typingInputSchema },
    async (arguments_, extra) =>
      await runTool(input, "start_typing", arguments_, extra.requestId, true, async () =>
        actionResult(await executeAction(input.actions, { kind: "start_typing", ...arguments_ })),
      ),
  );
  mcp.registerTool(
    "stop_typing",
    { description: "Discord typing表示を停止する", inputSchema: typingInputSchema },
    async (arguments_, extra) =>
      await runTool(input, "stop_typing", arguments_, extra.requestId, true, async () =>
        actionResult(await executeAction(input.actions, { kind: "stop_typing", ...arguments_ })),
      ),
  );

  const transport = new StreamableHTTPTransport();
  let connectPromise: Promise<void> | undefined;
  const app = new Hono();
  app.all(MCP_PATH, async (context) => {
    const typingOwner = context.req.header(DISCORD_MCP_TYPING_OWNER_HEADER);
    return await typingOwnerStorage.run(typingOwner, async () => {
      connectPromise ??= mcp.connect(transport);
      await connectPromise;
      return (await transport.handleRequest(context)) ?? context.body(null, 204);
    });
  });

  const started = await startHttpServer(app, input.onError);
  return {
    url: `http://${HOSTNAME}:${started.port}${MCP_PATH}`,
    close: async () => {
      await mcp.close();
      await stopHttpServer(started.server);
    },
  };
}

async function runTool<Result>(
  input: Readonly<{
    onEvent: (
      event: string,
      context: Readonly<{ actionIndex?: number; toolCallId: string }>,
      details: Readonly<Record<string, unknown>>,
      payload?: unknown,
    ) => void;
  }>,
  toolName: string,
  arguments_: unknown,
  requestId: string | number,
  isAction: boolean,
  operation: () => Promise<Result>,
): Promise<Result> {
  const context = { ...(isAction ? { actionIndex: 0 } : {}), toolCallId: String(requestId) };
  input.onEvent("discord.mcp_tool_started", context, { toolName }, arguments_);
  try {
    const toolResult = await operation();
    input.onEvent("discord.mcp_tool_completed", context, { toolName }, toolResult);
    return toolResult;
  } catch (error: unknown) {
    input.onEvent("discord.mcp_tool_failed", context, { error, toolName });
    throw error;
  }
}

async function executeAction(
  actions: DiscordActionPort,
  actionInput: unknown,
): Promise<DiscordActionSuccess> {
  const action: DiscordAction = discordActionSchema.parse(actionInput);
  const ownerId = z
    .string()
    .min(1)
    .refine((value) => value.trim() === value, "Typing owner must not contain outer whitespace")
    .parse(typingOwnerStorage.getStore());
  return await actions.execute(action, ownerId);
}

function result(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] } satisfies {
    content: Array<{ type: "text"; text: string }>;
  };
}

function actionResult(value: DiscordActionSuccess) {
  return result(value);
}

async function startHttpServer(
  app: Hono,
  onError: (error: Error) => void,
): Promise<{ port: number; server: ServerType }> {
  return await new Promise((resolve, reject) => {
    let started = false;
    const server = serve({ fetch: app.fetch, hostname: HOSTNAME, port: 0 }, (info) => {
      started = true;
      resolve({ port: info.port, server });
    });
    server.on("error", (error) => {
      if (!started) reject(error);
      else onError(error);
    });
  });
}

async function stopHttpServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
