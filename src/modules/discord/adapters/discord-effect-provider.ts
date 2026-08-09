import { isAbsolute } from "node:path";

import { z } from "zod";

import { defineEffect, type EffectProvider } from "../../effect/ports/effect-provider";
import type { JsonValue } from "../../event/domain/luna-event";
import {
  addReactionSchema,
  removeReactionSchema,
  replyMessageSchema,
  sendMessageSchema,
  startTypingSchema,
  stopTypingSchema,
  type DiscordAction,
  type DiscordEmoji,
} from "../domain/discord-action";
import { discordIdSchema } from "../domain/discord-id";
import type { DiscordActionPort, DiscordActionSuccess } from "../ports/discord-action-port";

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

export function createDiscordEffectProvider(actions: DiscordActionPort): EffectProvider {
  const executeAction = async (action: DiscordAction, ownerId: string): Promise<JsonValue> =>
    actionSuccessToJson(await actions.execute(action, ownerId));

  return Object.freeze({
    definitions: Object.freeze([
      defineEffect({
        type: "discord.send_message",
        agentInputSchema: agentSendMessageSchema,
        inputSchema: sendMessageSchema,
        parseInput: (input) =>
          sendMessageSchema.parse({
            kind: "send_message",
            target: input.target,
            ...normalizeMessageFields(input),
          }),
        execute: async (action, ownerId) => await executeAction(action, ownerId),
        describeTarget: (action) => action.target,
      }),
      defineEffect({
        type: "discord.reply_message",
        agentInputSchema: agentReplyMessageSchema,
        inputSchema: replyMessageSchema,
        parseInput: (input) =>
          replyMessageSchema.parse({
            kind: "reply_message",
            channelId: input.channelId,
            messageId: input.messageId,
            ...normalizeMessageFields(input),
          }),
        execute: async (action, ownerId) => await executeAction(action, ownerId),
        describeTarget: (action) => ({
          kind: "message",
          channelId: action.channelId,
          messageId: action.messageId,
        }),
      }),
      defineEffect({
        type: "discord.add_reaction",
        agentInputSchema: agentReactionSchema,
        inputSchema: addReactionSchema,
        parseInput: (input) =>
          addReactionSchema.parse({
            kind: "add_reaction",
            channelId: input.channelId,
            messageId: input.messageId,
            emoji: normalizeEmoji(input.emoji),
          }),
        execute: async (action, ownerId) => await executeAction(action, ownerId),
        describeTarget: (action) => messageTarget(action),
      }),
      defineEffect({
        type: "discord.remove_reaction",
        agentInputSchema: agentReactionSchema,
        inputSchema: removeReactionSchema,
        parseInput: (input) =>
          removeReactionSchema.parse({
            kind: "remove_reaction",
            channelId: input.channelId,
            messageId: input.messageId,
            emoji: normalizeEmoji(input.emoji),
          }),
        execute: async (action, ownerId) => await executeAction(action, ownerId),
        describeTarget: (action) => messageTarget(action),
      }),
      defineEffect({
        type: "discord.start_typing",
        agentInputSchema: agentTypingSchema,
        inputSchema: startTypingSchema,
        parseInput: (input) =>
          startTypingSchema.parse({ kind: "start_typing", target: input.target }),
        execute: async (action, ownerId) => await executeAction(action, ownerId),
        describeTarget: (action) => action.target,
      }),
      defineEffect({
        type: "discord.stop_typing",
        agentInputSchema: agentTypingSchema,
        inputSchema: stopTypingSchema,
        parseInput: (input) =>
          stopTypingSchema.parse({ kind: "stop_typing", target: input.target }),
        execute: async (action, ownerId) => await executeAction(action, ownerId),
        describeTarget: (action) => action.target,
      }),
    ]),
    release: async (ownerId: string) => await actions.releaseTyping(ownerId),
  });
}

function requireMessageBody(
  input: { content: string | null; files: readonly unknown[] | null },
  context: z.RefinementCtx,
): void {
  if (input.content === null && input.files === null) {
    context.addIssue({ code: "custom", message: "A message requires content or files" });
  }
}

function normalizeMessageFields(input: {
  content: string | null;
  files: readonly z.infer<typeof agentSendFileSchema>[] | null;
}): Readonly<{
  content?: string;
  files?: readonly Readonly<{ path: string; fileName?: string; description?: string }>[];
}> {
  return {
    ...(input.content === null ? {} : { content: input.content }),
    ...(input.files === null
      ? {}
      : {
          files: input.files.map((file) => ({
            path: file.path,
            ...(file.fileName === null ? {} : { fileName: file.fileName }),
            ...(file.description === null ? {} : { description: file.description }),
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
        ...(emoji.name === null ? {} : { name: emoji.name }),
      };
}

function messageTarget(action: { channelId: string; messageId: string }): JsonValue {
  return { kind: "message", channelId: action.channelId, messageId: action.messageId };
}

function actionSuccessToJson(result: DiscordActionSuccess): JsonValue {
  return result.detail === undefined
    ? { actionKind: result.actionKind }
    : { actionKind: result.actionKind, detail: result.detail };
}
