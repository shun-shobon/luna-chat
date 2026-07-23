import { isAbsolute } from "node:path";

import { z } from "zod";

import { discordIdSchema } from "./discord-id";

export const discordTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("channel"), channelId: discordIdSchema }),
  z.strictObject({ kind: z.literal("dm_user"), userId: discordIdSchema }),
]);

export const sendFileSchema = z.strictObject({
  path: z.string().min(1).refine(isAbsolute, "File path must be absolute"),
  fileName: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});

export const discordEmojiSchema = z.discriminatedUnion("kind", [
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

const sendMessageSchema = z.strictObject({
  kind: z.literal("send_message"),
  target: discordTargetSchema,
  content: z.string().min(1).max(2_000).optional(),
  files: z.array(sendFileSchema).min(1).optional(),
});

const replyMessageSchema = z.strictObject({
  kind: z.literal("reply_message"),
  ...messageLocationShape,
  content: z.string().min(1).max(2_000).optional(),
  files: z.array(sendFileSchema).min(1).optional(),
});

export const discordActionSchema = z
  .discriminatedUnion("kind", [
    sendMessageSchema,
    replyMessageSchema,
    z.strictObject({
      kind: z.literal("add_reaction"),
      ...messageLocationShape,
      emoji: discordEmojiSchema,
    }),
    z.strictObject({
      kind: z.literal("remove_reaction"),
      ...messageLocationShape,
      emoji: discordEmojiSchema,
    }),
    z.strictObject({ kind: z.literal("start_typing"), target: discordTargetSchema }),
    z.strictObject({ kind: z.literal("stop_typing"), target: discordTargetSchema }),
  ])
  .superRefine((action, context) => {
    if (
      (action.kind === "send_message" || action.kind === "reply_message") &&
      action.content === undefined &&
      action.files === undefined
    ) {
      context.addIssue({ code: "custom", message: "A message requires content or files" });
    }
  });

export const agentOutputSchema = z.strictObject({
  actions: z.array(discordActionSchema),
});

export type DiscordTarget = z.infer<typeof discordTargetSchema>;
export type SendFile = z.infer<typeof sendFileSchema>;
export type DiscordEmoji = z.infer<typeof discordEmojiSchema>;
export type DiscordAction = z.infer<typeof discordActionSchema>;
export type AgentOutput = z.infer<typeof agentOutputSchema>;
