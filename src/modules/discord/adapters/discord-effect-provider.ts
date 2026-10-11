import { isAbsolute } from "node:path";

import { z } from "zod";

import type { JsonValue } from "../../../shared/json";
import { defineEffect } from "../../effect/ports/effect-provider";
import type { EffectProvider } from "../../effect/ports/effect-provider";
import type { DiscordAction, DiscordEmoji, SendFile } from "../domain/discord-action";
import { discordIdSchema } from "../domain/discord-id";
import type { DiscordActionPort, DiscordActionSuccess } from "../ports/discord-action-port";
import type { DiscordConversationDelegationPort } from "../ports/discord-conversation-delegation-port";

type ActionOf<Kind extends DiscordAction["kind"]> = Extract<DiscordAction, { kind: Kind }>;

const nonEmptyStringSchema = z.string().superRefine((value, context) => {
	if (value.length === 0) context.addIssue({ code: "custom", message: "String must not be empty" });
});
const messageContentSchema = z.string().superRefine((value, context) => {
	if (value.length === 0) context.addIssue({ code: "custom", message: "String must not be empty" });
	if (value.length > 2_000) {
		context.addIssue({
			code: "custom",
			message: "Discord message must not exceed 2000 characters",
		});
	}
});
const absolutePathSchema = z.string().superRefine((value, context) => {
	if (!isAbsolute(value)) {
		context.addIssue({ code: "custom", message: "File path must be absolute" });
	}
});

const agentDiscordTargetSchema = z.union([
	z.strictObject({ kind: z.literal("channel"), channelId: discordIdSchema }),
	z.strictObject({ kind: z.literal("dm_user"), userId: discordIdSchema }),
]);
const agentSendFileSchema = z.strictObject({
	path: absolutePathSchema,
	fileName: nonEmptyStringSchema.nullable(),
	description: nonEmptyStringSchema.nullable(),
});
const agentDiscordEmojiSchema = z.union([
	z.strictObject({ kind: z.literal("unicode"), value: nonEmptyStringSchema }),
	z.strictObject({
		kind: z.literal("custom"),
		id: discordIdSchema,
		name: nonEmptyStringSchema.nullable(),
	}),
]);
const nullableMessageFields = {
	content: messageContentSchema.nullable(),
	files: z.array(agentSendFileSchema).min(1).nullable(),
};
const agentSendMessageSchema = z
	.strictObject({ target: agentDiscordTargetSchema, ...nullableMessageFields })
	.superRefine(requireMessageBody);
const agentReplyMessageSchema = z
	.strictObject({
		channelId: discordIdSchema,
		messageId: discordIdSchema,
		...nullableMessageFields,
	})
	.superRefine(requireMessageBody);
const agentReactionSchema = z.strictObject({
	channelId: discordIdSchema,
	messageId: discordIdSchema,
	emoji: agentDiscordEmojiSchema,
});
const agentTypingSchema = z.strictObject({ target: agentDiscordTargetSchema });
const agentOpenConversationSchema = z.strictObject({
	target: agentDiscordTargetSchema,
	brief: nonEmptyStringSchema,
});

export function createDiscordEffectProvider(actions: DiscordActionPort): EffectProvider {
	const executeAction = async (action: DiscordAction, ownerId: string): Promise<JsonValue> =>
		actionSuccessToJson(await actions.execute(action, ownerId));

	return Object.freeze({
		definitions: Object.freeze([
			defineEffect({
				type: "discord.send_message",
				agentInputSchema: agentSendMessageSchema,
				parseInput: (input): ActionOf<"send_message"> => ({
					kind: "send_message",
					target: input.target,
					...normalizeMessageFields(input),
				}),
				execute: executeAction,
				describeTarget: (action) => action.target,
			}),
			defineEffect({
				type: "discord.reply_message",
				agentInputSchema: agentReplyMessageSchema,
				parseInput: (input): ActionOf<"reply_message"> => ({
					kind: "reply_message",
					channelId: input.channelId,
					messageId: input.messageId,
					...normalizeMessageFields(input),
				}),
				execute: executeAction,
				describeTarget: messageTarget,
			}),
			defineEffect({
				type: "discord.add_reaction",
				agentInputSchema: agentReactionSchema,
				parseInput: (input): ActionOf<"add_reaction"> => ({
					kind: "add_reaction",
					channelId: input.channelId,
					messageId: input.messageId,
					emoji: normalizeEmoji(input.emoji),
				}),
				execute: executeAction,
				describeTarget: messageTarget,
			}),
			defineEffect({
				type: "discord.remove_reaction",
				agentInputSchema: agentReactionSchema,
				parseInput: (input): ActionOf<"remove_reaction"> => ({
					kind: "remove_reaction",
					channelId: input.channelId,
					messageId: input.messageId,
					emoji: normalizeEmoji(input.emoji),
				}),
				execute: executeAction,
				describeTarget: messageTarget,
			}),
			defineEffect({
				type: "discord.start_typing",
				agentInputSchema: agentTypingSchema,
				parseInput: (input): ActionOf<"start_typing"> => ({
					kind: "start_typing",
					target: input.target,
				}),
				execute: executeAction,
				describeTarget: (action) => action.target,
			}),
			defineEffect({
				type: "discord.stop_typing",
				agentInputSchema: agentTypingSchema,
				parseInput: (input): ActionOf<"stop_typing"> => ({
					kind: "stop_typing",
					target: input.target,
				}),
				execute: executeAction,
				describeTarget: (action) => action.target,
			}),
		]),
		release: async (ownerId: string) => await actions.releaseTyping(ownerId),
	});
}

export function createDiscordDelegationEffectProvider(
	delegation: DiscordConversationDelegationPort,
): EffectProvider {
	return Object.freeze({
		definitions: Object.freeze([
			defineEffect({
				type: "discord.open_conversation",
				agentInputSchema: agentOpenConversationSchema,
				parseInput: (input) => input,
				execute: async (input) => ({
					scope: await delegation.delegate(input.target, input.brief),
				}),
				describeTarget: (input) => input.target,
			}),
		]),
		release: () => Promise.resolve(),
	});
}

function requireMessageBody(
	input: { content: string | null; files: readonly unknown[] | null },
	context: z.RefinementCtx,
): void {
	if (input.content == null && input.files == null) {
		context.addIssue({ code: "custom", message: "A message requires content or files" });
	}
}

function normalizeMessageFields(input: {
	content: string | null;
	files: readonly z.infer<typeof agentSendFileSchema>[] | null;
}): { content?: string; files?: SendFile[] } {
	return {
		...(input.content == null ? {} : { content: input.content }),
		...(input.files == null
			? {}
			: {
					files: input.files.map((file) => ({
						path: file.path,
						...(file.fileName == null ? {} : { fileName: file.fileName }),
						...(file.description == null ? {} : { description: file.description }),
					})),
				}),
	};
}

function normalizeEmoji(emoji: z.infer<typeof agentDiscordEmojiSchema>): DiscordEmoji {
	return emoji.kind === "unicode"
		? emoji
		: {
				kind: emoji.kind,
				id: emoji.id,
				...(emoji.name == null ? {} : { name: emoji.name }),
			};
}

function messageTarget(action: { channelId: string; messageId: string }): JsonValue {
	return { kind: "message", channelId: action.channelId, messageId: action.messageId };
}

function actionSuccessToJson(result: DiscordActionSuccess): JsonValue {
	return { actionKind: result.actionKind, detail: result.detail };
}
