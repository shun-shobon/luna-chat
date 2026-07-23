import { z } from "zod";

import { discordIdSchema } from "./discord-id";

const optionalDisplayNameSchema = z.string().min(1).nullable();

const discordAuthorSchema = z.strictObject({
  id: discordIdSchema,
  kind: z.enum(["human", "bot", "webhook", "system"]),
  username: z.string().min(1),
  displayName: optionalDisplayNameSchema,
});

const discordAttachmentSchema = z.strictObject({
  id: discordIdSchema,
  name: z.string().min(1).nullable(),
  url: z.url(),
  contentType: z.string().min(1).nullable(),
  size: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});

const discordStickerSchema = z.strictObject({
  id: discordIdSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  format: z.string().min(1),
});

const discordReactionSchema = z.strictObject({
  emoji: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("unicode"), value: z.string().min(1) }),
    z.strictObject({
      kind: z.literal("custom"),
      id: discordIdSchema,
      name: z.string().min(1).nullable(),
      animated: z.boolean(),
    }),
  ]),
  count: z.number().int().nonnegative(),
  me: z.boolean(),
});

const discordMentionsSchema = z.strictObject({
  users: z.array(
    z.strictObject({
      id: discordIdSchema,
      username: z.string().min(1),
      displayName: optionalDisplayNameSchema,
    }),
  ),
  roles: z.array(z.strictObject({ id: discordIdSchema, name: z.string().min(1).nullable() })),
  channels: z.array(z.strictObject({ id: discordIdSchema, name: z.string().min(1).nullable() })),
  everyone: z.boolean(),
});

const discordReplyReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("guild"),
    guildId: discordIdSchema,
    channelId: discordIdSchema,
    messageId: discordIdSchema,
  }),
  z.strictObject({
    kind: z.literal("dm"),
    channelId: discordIdSchema,
    messageId: discordIdSchema,
  }),
]);

export const discordMessageSchema = z.strictObject({
  id: discordIdSchema,
  timestamp: z.iso.datetime({ offset: true }),
  kind: z.enum(["default", "reply", "system"]),
  guild: z.strictObject({ id: discordIdSchema, name: z.string().min(1) }).nullable(),
  channel: z.strictObject({ id: discordIdSchema, name: z.string().min(1).nullable() }),
  author: discordAuthorSchema,
  content: z.string(),
  attachments: z.array(discordAttachmentSchema),
  stickers: z.array(discordStickerSchema),
  reactions: z.array(discordReactionSchema),
  mentions: discordMentionsSchema,
  replyTo: discordReplyReferenceSchema.nullable(),
});

export type DiscordMessage = z.infer<typeof discordMessageSchema>;
