import { AsyncLocalStorage } from "node:async_hooks";

import { StreamableHTTPTransport } from "@hono/mcp";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { z } from "zod";

import {
	reactionInputSchema,
	replyMessageInputSchema,
	sendMessageInputSchema,
	typingInputSchema,
} from "../domain/discord-action";
import type { DiscordAction } from "../domain/discord-action";
import { discordIdSchema } from "../domain/discord-id";
import type { DiscordActionPort } from "../ports/discord-action-port";
import type { DiscordReadPort } from "../ports/discord-read-port";

const HOSTNAME = "127.0.0.1";
const MCP_PATH = "/mcp";
export const DISCORD_MCP_TYPING_OWNER_HEADER = "X-Luna-Typing-Owner";

const typingOwnerStorage = new AsyncLocalStorage<string | undefined>();
const typingOwnerSchema = z.string().min(1);

type McpToolEventHandler = (
	event: string,
	context: Readonly<{ actionIndex?: number; toolCallId: string }>,
	details: Readonly<Record<string, unknown>>,
	payload?: unknown,
) => void;

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

export type DiscordMcpServerHandle = Readonly<{
	url: string;
	close(): Promise<void>;
}>;

export async function startDiscordMcpServer(
	input: Readonly<{
		actions: DiscordActionPort;
		onError: (error: Error) => void;
		onEvent: McpToolEventHandler;
		read: DiscordReadPort;
	}>,
): Promise<DiscordMcpServerHandle> {
	const mcp = new McpServer({ name: "luna-discord", version: "1.0.0" });

	const register = <Input>(
		name: string,
		description: string,
		inputSchema: z.ZodType<Input>,
		isAction: boolean,
		operation: (arguments_: Input) => Promise<unknown>,
	): void => {
		mcp.registerTool(name, { description, inputSchema }, async (arguments_, extra) =>
			result(
				await runTool(
					input.onEvent,
					name,
					arguments_,
					extra.requestId,
					isAction,
					async () => await operation(arguments_),
				),
			),
		);
	};
	const executeAction = async (action: DiscordAction) =>
		await input.actions.execute(action, typingOwnerSchema.parse(typingOwnerStorage.getStore()));

	register(
		"read_message_history",
		"Discord message historyを読む",
		historyInputSchema,
		false,
		async (arguments_) => await input.read.readMessageHistory(arguments_),
	);
	register(
		"list_channels",
		"到達可能なDiscord channelとthreadを列挙する",
		emptyInputSchema,
		false,
		async () => await input.read.listChannels(),
	);
	register(
		"get_user_detail",
		"Discord userと任意のGuild member詳細を読む",
		getUserInputSchema,
		false,
		async (arguments_) => await input.read.getUserDetail(arguments_),
	);
	register(
		"list_guild_emojis",
		"Guild emojiを列挙する",
		listGuildEmojisInputSchema,
		false,
		async (arguments_) => await input.read.listGuildEmojis(arguments_.guildId),
	);
	register(
		"get_guild_emoji",
		"Guild emojiの詳細を読む",
		getGuildEmojiInputSchema,
		false,
		async (arguments_) => await input.read.getGuildEmoji(arguments_),
	);
	register(
		"send_message",
		"Discord messageを送信する",
		sendMessageInputSchema,
		true,
		async (arguments_) => await executeAction({ kind: "send_message", ...arguments_ }),
	);
	register(
		"reply_message",
		"Discord messageへ返信する",
		replyMessageInputSchema,
		true,
		async (arguments_) => await executeAction({ kind: "reply_message", ...arguments_ }),
	);
	register(
		"add_reaction",
		"Discord messageへreactionを追加する",
		reactionInputSchema,
		true,
		async (arguments_) => await executeAction({ kind: "add_reaction", ...arguments_ }),
	);
	register(
		"remove_reaction",
		"Discord messageからLunaのreactionを削除する",
		reactionInputSchema,
		true,
		async (arguments_) => await executeAction({ kind: "remove_reaction", ...arguments_ }),
	);
	register(
		"start_typing",
		"Discord typing表示を開始する",
		typingInputSchema,
		true,
		async (arguments_) => await executeAction({ kind: "start_typing", ...arguments_ }),
	);
	register(
		"stop_typing",
		"Discord typing表示を停止する",
		typingInputSchema,
		true,
		async (arguments_) => await executeAction({ kind: "stop_typing", ...arguments_ }),
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
	onEvent: McpToolEventHandler,
	toolName: string,
	arguments_: unknown,
	requestId: string | number,
	isAction: boolean,
	operation: () => Promise<Result>,
): Promise<Result> {
	const context = { ...(isAction ? { actionIndex: 0 } : {}), toolCallId: String(requestId) };
	onEvent("discord.mcp_tool_started", context, { toolName }, arguments_);
	try {
		const toolResult = await operation();
		onEvent("discord.mcp_tool_completed", context, { toolName }, toolResult);
		return toolResult;
	} catch (error: unknown) {
		onEvent("discord.mcp_tool_failed", context, { error, toolName });
		throw error;
	}
}

function result(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
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
		server.on("error", (error: Error) => {
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
