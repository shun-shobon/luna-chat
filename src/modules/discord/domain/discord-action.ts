import { isAbsolute } from "node:path";

import { z } from "zod";

import { discordIdSchema } from "./discord-id";

const discordTargetSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("channel"), channelId: discordIdSchema }),
	z.strictObject({ kind: z.literal("dm_user"), userId: discordIdSchema }),
]);

const sendFileSchema = z.strictObject({
	path: z.string().min(1).refine(isAbsolute, "File path must be absolute"),
	fileName: z.string().min(1).optional(),
	description: z.string().min(1).optional(),
});

const discordEmojiSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("unicode"), value: z.string().min(1) }),
	z.strictObject({
		kind: z.literal("custom"),
		id: discordIdSchema,
		name: z.string().min(1).optional(),
	}),
]);

const messageLocationShape = {
	channelId: discordIdSchema,
	messageId: discordIdSchema,
};

const messageBodyShape = {
	content: z.string().min(1).max(2_000).optional(),
	files: z.array(sendFileSchema).min(1).optional(),
};

function requireMessageBody(
	input: Readonly<{ content?: string | undefined; files?: readonly unknown[] | undefined }>,
	context: z.RefinementCtx,
): void {
	if (input.content === undefined && input.files === undefined) {
		context.addIssue({ code: "custom", message: "A message requires content or files" });
	}
}

export const sendMessageInputSchema = z
	.strictObject({ target: discordTargetSchema, ...messageBodyShape })
	.superRefine(requireMessageBody);
export const replyMessageInputSchema = z
	.strictObject({ ...messageLocationShape, ...messageBodyShape })
	.superRefine(requireMessageBody);
export const reactionInputSchema = z.strictObject({
	...messageLocationShape,
	emoji: discordEmojiSchema,
});
export const typingInputSchema = z.strictObject({ target: discordTargetSchema });

export type DiscordTarget = z.infer<typeof discordTargetSchema>;
export type SendFile = z.infer<typeof sendFileSchema>;
export type DiscordEmoji = z.infer<typeof discordEmojiSchema>;
export type DiscordAction =
	| ({ kind: "send_message" } & z.infer<typeof sendMessageInputSchema>)
	| ({ kind: "reply_message" } & z.infer<typeof replyMessageInputSchema>)
	| ({ kind: "add_reaction" } & z.infer<typeof reactionInputSchema>)
	| ({ kind: "remove_reaction" } & z.infer<typeof reactionInputSchema>)
	| ({ kind: "start_typing" } & z.infer<typeof typingInputSchema>)
	| ({ kind: "stop_typing" } & z.infer<typeof typingInputSchema>);
