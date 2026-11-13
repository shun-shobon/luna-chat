import { z } from "zod";

import type { JsonValue } from "../../../shared/json";
import type { ToolExecution } from "../../tool/domain/tool";
import { defineTool } from "../../tool/ports/tool-provider";
import type { ToolDefinition, ToolProvider } from "../../tool/ports/tool-provider";
import {
	reactionInputSchema,
	replyMessageInputSchema,
	sendMessageInputSchema,
	typingInputSchema,
} from "../domain/discord-action";
import type { DiscordAction, DiscordTarget } from "../domain/discord-action";
import { discordIdSchema } from "../domain/discord-id";
import type { DiscordActionPort } from "../ports/discord-action-port";
import type { DiscordConversationDelegationPort } from "../ports/discord-conversation-delegation-port";
import type { DiscordReadPort } from "../ports/discord-read-port";

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
const openConversationInputSchema = z.strictObject({
	target: typingInputSchema.shape.target,
	brief: z.string().trim().min(1),
});

type DiscordToolPorts = Readonly<{
	actions: DiscordActionPort;
	delegation: DiscordConversationDelegationPort;
	read: DiscordReadPort;
}>;

export function createDiscordReadToolProvider(read: DiscordReadPort): ToolProvider {
	return Object.freeze({
		definitions: readDefinitions(read),
		release: async () => {},
	});
}

export function createDiscordToolProvider(ports: DiscordToolPorts): ToolProvider {
	return Object.freeze({
		definitions: Object.freeze([
			...readDefinitions(ports.read),
			...writeDefinitions(ports.actions),
			defineTool({
				name: "open_conversation",
				description:
					"Hand a topic to the conversation in the target channel or DM so that it starts talking there with this brief as background. Use it instead of posting directly when you want an ongoing conversation.",
				inputSchema: openConversationInputSchema,
				parseInput: (input) => input,
				execute: async (input) => ({
					scope: await ports.delegation.delegate(input.target, input.brief),
				}),
				describeTarget: (input) => input.target,
			}),
		]),
		release: async (ownerId: string) => await ports.actions.releaseTyping(ownerId),
	});
}

function readDefinitions(read: DiscordReadPort): readonly ToolDefinition[] {
	return [
		defineTool({
			name: "read_message_history",
			description:
				"Read Discord message history of a channel, thread, or DM. Specify at most one of beforeMessageId, afterMessageId, and aroundMessageId.",
			inputSchema: historyInputSchema,
			parseInput: (input) => input,
			execute: async (input) => await read.readMessageHistory(input),
			describeTarget: (input) => ({ kind: "channel", channelId: input.channelId }),
		}),
		defineTool({
			name: "list_channels",
			description: "List the Discord channels, threads, and DMs Luna can reach.",
			inputSchema: emptyInputSchema,
			parseInput: (input) => input,
			execute: async () => await read.listChannels(),
			describeTarget: () => null,
		}),
		defineTool({
			name: "get_user_detail",
			description: "Read a Discord user and, with guildId, the guild member details.",
			inputSchema: getUserInputSchema,
			parseInput: (input) => input,
			execute: async (input) => await read.getUserDetail(input),
			describeTarget: (input) => ({ kind: "user", userId: input.userId }),
		}),
		defineTool({
			name: "list_guild_emojis",
			description: "List the custom emojis of a guild.",
			inputSchema: listGuildEmojisInputSchema,
			parseInput: (input) => input,
			execute: async (input) => await read.listGuildEmojis(input.guildId),
			describeTarget: (input) => ({ kind: "guild", guildId: input.guildId }),
		}),
		defineTool({
			name: "get_guild_emoji",
			description: "Read one custom emoji of a guild.",
			inputSchema: getGuildEmojiInputSchema,
			parseInput: (input) => input,
			execute: async (input) => await read.getGuildEmoji(input),
			describeTarget: (input) => ({ kind: "guild", guildId: input.guildId }),
		}),
	];
}

function writeDefinitions(actions: DiscordActionPort): readonly ToolDefinition[] {
	const execute = async (action: DiscordAction, execution: ToolExecution): Promise<unknown> => {
		const result = await actions.execute(action, execution.ownerId);
		return { actionKind: result.actionKind, detail: result.detail };
	};
	return [
		defineTool({
			name: "send_message",
			description:
				"Send a Discord message to a channel or DM. content is at most 2000 characters; files are absolute paths. A message needs content or files.",
			inputSchema: sendMessageInputSchema,
			parseInput: (input): DiscordAction => ({ kind: "send_message", ...input }),
			execute,
			describeTarget: describeAction,
		}),
		defineTool({
			name: "reply_message",
			description:
				"Reply to a Discord message. content is at most 2000 characters; files are absolute paths. A reply needs content or files.",
			inputSchema: replyMessageInputSchema,
			parseInput: (input): DiscordAction => ({ kind: "reply_message", ...input }),
			execute,
			describeTarget: describeAction,
		}),
		defineTool({
			name: "add_reaction",
			description: "Add a reaction to a Discord message.",
			inputSchema: reactionInputSchema,
			parseInput: (input): DiscordAction => ({ kind: "add_reaction", ...input }),
			execute,
			describeTarget: describeAction,
		}),
		defineTool({
			name: "remove_reaction",
			description: "Remove Luna's reaction from a Discord message.",
			inputSchema: reactionInputSchema,
			parseInput: (input): DiscordAction => ({ kind: "remove_reaction", ...input }),
			execute,
			describeTarget: describeAction,
		}),
		defineTool({
			name: "start_typing",
			description:
				"Show the typing indicator in a channel or DM until stop_typing or the end of this run.",
			inputSchema: typingInputSchema,
			parseInput: (input): DiscordAction => ({ kind: "start_typing", ...input }),
			execute,
			describeTarget: describeAction,
		}),
		defineTool({
			name: "stop_typing",
			description: "Stop the typing indicator started by start_typing.",
			inputSchema: typingInputSchema,
			parseInput: (input): DiscordAction => ({ kind: "stop_typing", ...input }),
			execute,
			describeTarget: describeAction,
		}),
	];
}

function describeAction(action: DiscordAction): JsonValue {
	if ("target" in action) return describeTarget(action.target);
	return { kind: "message", channelId: action.channelId, messageId: action.messageId };
}

function describeTarget(target: DiscordTarget): JsonValue {
	return target.kind === "channel"
		? { kind: "channel", channelId: target.channelId }
		: { kind: "dm_user", userId: target.userId };
}
