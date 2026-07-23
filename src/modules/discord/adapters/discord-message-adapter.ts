import { z } from "zod";

import {
  normalizeDiscordMessage,
  type DiscordMessageSource,
} from "../application/normalize-discord-message";
import { conversationScopeSchema, type ConversationScope } from "../domain/conversation-scope";
import { discordIdSchema } from "../domain/discord-id";
import type { DiscordGatewayMessage, DiscordGatewayTyping } from "../ports/discord-gateway-port";

type CollectionLike = Readonly<{ values: () => unknown }>;
type Callable = (...arguments_: unknown[]) => unknown;

const collectionSchema = z.custom<CollectionLike>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "values") === "function",
);
const callableSchema = z.custom<Callable>((value) => typeof value === "function");

const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  globalName: z.string().nullable(),
  bot: z.boolean(),
  system: z.boolean(),
});

const channelSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  recipient: userSchema.nullable().optional(),
  isThread: callableSchema,
  isDMBased: callableSchema,
});

const sdkMessageSchema = z.object({
  id: z.string(),
  createdAt: z.date(),
  system: z.boolean(),
  guild: z.object({ id: z.string(), name: z.string() }).nullable(),
  channel: channelSchema,
  author: userSchema,
  member: z.object({ displayName: z.string() }).nullable().optional(),
  webhookId: z.string().nullable(),
  content: z.string(),
  attachments: collectionSchema,
  stickers: collectionSchema,
  reactions: z.object({ cache: collectionSchema }),
  mentions: z.object({
    users: collectionSchema,
    roles: collectionSchema,
    channels: collectionSchema,
    everyone: z.boolean(),
  }),
  reference: z
    .object({
      messageId: z.string().nullable().optional(),
      channelId: z.string().nullable().optional(),
      guildId: z.string().nullable().optional(),
    })
    .nullable(),
});

const attachmentSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  url: z.string(),
  contentType: z.string().nullable(),
  size: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
});

const stickerSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  format: z.union([z.number(), z.string()]),
});

const reactionSchema = z.object({
  count: z.number(),
  me: z.boolean(),
  emoji: z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    animated: z.boolean().nullable(),
  }),
});

const roleSchema = z.object({ id: z.string(), name: z.string().nullable() });
const mentionedChannelSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
});

const sdkTypingSchema = z.object({
  channel: channelSchema,
  guild: z.object({ id: z.string() }).nullable(),
  user: userSchema,
});

export function toDiscordGatewayMessage(message: unknown): DiscordGatewayMessage {
  const source = toDiscordMessageSource(message);
  return {
    message: normalizeDiscordMessage(source),
    scope: resolveMessageScope(message),
  };
}

export function toDiscordGatewayTyping(typing: unknown): DiscordGatewayTyping {
  const parsed = sdkTypingSchema.parse(typing);
  return {
    scope: resolveScope({ channel: parsed.channel, guildId: parsed.guild?.id ?? null }),
    userId: discordIdSchema.parse(parsed.user.id),
    isHuman: !parsed.user.bot && !parsed.user.system,
  };
}

export function toDiscordMessageSource(message: unknown): DiscordMessageSource {
  const parsed = sdkMessageSchema.parse(message);
  const guild = parsed.guild === null ? null : { id: parsed.guild.id, name: parsed.guild.name };

  return {
    id: parsed.id,
    timestamp: parsed.createdAt,
    system: parsed.system,
    guild,
    channel: {
      id: parsed.channel.id,
      name: parsed.channel.name ?? null,
    },
    author: {
      id: parsed.author.id,
      username: parsed.author.username,
      displayName: parsed.member?.displayName ?? parsed.author.globalName,
      bot: parsed.author.bot,
      system: parsed.author.system,
    },
    webhookId: parsed.webhookId,
    content: parsed.content,
    attachments: collectionValues(parsed.attachments).map((value) => attachmentSchema.parse(value)),
    stickers: collectionValues(parsed.stickers).map((value) => {
      const sticker = stickerSchema.parse(value);
      return {
        id: sticker.id,
        name: sticker.name,
        description: sticker.description,
        format: String(sticker.format),
      };
    }),
    reactions: collectionValues(parsed.reactions.cache).map(toReactionSource),
    mentions: {
      users: collectionValues(parsed.mentions.users).map((value) => {
        const user = userSchema.parse(value);
        return { id: user.id, username: user.username, displayName: user.globalName };
      }),
      roles: collectionValues(parsed.mentions.roles).map((value) => roleSchema.parse(value)),
      channels: collectionValues(parsed.mentions.channels).map((value) => {
        const channel = mentionedChannelSchema.parse(value);
        return { id: channel.id, name: channel.name ?? null };
      }),
      everyone: parsed.mentions.everyone,
    },
    replyTo: toReplyReference(parsed),
  };
}

function resolveMessageScope(message: unknown): ConversationScope {
  const parsed = sdkMessageSchema.parse(message);
  return resolveScope({ channel: parsed.channel, guildId: parsed.guild?.id ?? null });
}

function resolveScope(input: {
  channel: z.infer<typeof channelSchema>;
  guildId: string | null;
}): ConversationScope {
  if (callBooleanMethod(input.channel, "isThread")) {
    return conversationScopeSchema.parse({
      kind: "guild_thread",
      guildId: input.guildId,
      parentChannelId: input.channel.parentId,
      threadId: input.channel.id,
    });
  }

  if (callBooleanMethod(input.channel, "isDMBased")) {
    return conversationScopeSchema.parse({
      kind: "dm",
      channelId: input.channel.id,
      userId: input.channel.recipient?.id,
    });
  }

  return conversationScopeSchema.parse({
    kind: "guild_channel",
    guildId: input.guildId,
    channelId: input.channel.id,
  });
}

function toReplyReference(
  message: z.infer<typeof sdkMessageSchema>,
): DiscordMessageSource["replyTo"] {
  const messageId = message.reference?.messageId;
  if (messageId === undefined || messageId === null) return null;

  if (message.guild === null) {
    return {
      kind: "dm",
      channelId: discordIdSchema.parse(message.reference?.channelId),
      messageId,
    };
  }

  return {
    kind: "guild",
    guildId: discordIdSchema.parse(message.reference?.guildId ?? message.guild.id),
    channelId: discordIdSchema.parse(message.reference?.channelId),
    messageId,
  };
}

function toReactionSource(value: unknown): DiscordMessageSource["reactions"][number] {
  const reaction = reactionSchema.parse(value);
  if (reaction.emoji.id === null) {
    return {
      emoji: { kind: "unicode", value: z.string().min(1).parse(reaction.emoji.name) },
      count: reaction.count,
      me: reaction.me,
    };
  }

  return {
    emoji: {
      kind: "custom",
      id: reaction.emoji.id,
      name: reaction.emoji.name,
      animated: reaction.emoji.animated === true,
    },
    count: reaction.count,
    me: reaction.me,
  };
}

function collectionValues(collection: CollectionLike): unknown[] {
  const result = Reflect.apply(collection.values, collection, []);
  if (!isIterable(result)) throw new Error("Discord SDK collection is not iterable");
  return Array.from(result);
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, Symbol.iterator) === "function"
  );
}

function callBooleanMethod(
  target: z.infer<typeof channelSchema>,
  method: "isDMBased" | "isThread",
): boolean {
  return z.boolean().parse(Reflect.apply(target[method], target, []));
}
