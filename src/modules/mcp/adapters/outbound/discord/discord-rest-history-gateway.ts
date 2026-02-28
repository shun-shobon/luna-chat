import { REST, Routes } from "discord.js";
import { z } from "zod";

import { toRuntimeReactions } from "../../../../../shared/discord/runtime-reaction";
import type {
  DiscordChannelSummary,
  DiscordGuildMemberDetail,
  DiscordGuildSummary,
  DiscordHistoryGateway,
  DiscordHistoryMessage,
  DiscordUserDetail,
} from "../../../ports/outbound/discord-history-gateway-port";

const discordApiAttachmentSchema = z.object({
  filename: z.string(),
  id: z.string(),
  url: z.string(),
});

const discordApiReactionEmojiSchema = z.object({
  id: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});

const discordApiReactionSchema = z.object({
  count: z.number().int().min(0),
  emoji: discordApiReactionEmojiSchema,
  me: z.boolean().optional().default(false),
});

const discordApiMessageSchema = z.object({
  attachments: z.array(discordApiAttachmentSchema).optional().default([]),
  author: z.object({
    bot: z.boolean().optional().default(false),
    id: z.string(),
    username: z.string(),
  }),
  content: z.string(),
  id: z.string(),
  reactions: z.array(discordApiReactionSchema).optional().default([]),
  timestamp: z.string(),
});

const discordApiChannelSchema = z.object({
  guild_id: z.string().nullable().optional(),
  id: z.string(),
  name: z.string(),
  type: z.number().int(),
});

const discordApiUserSchema = z.object({
  avatar: z.string().nullable().optional(),
  banner: z.string().nullable().optional(),
  bot: z.boolean().optional().default(false),
  global_name: z.string().nullable().optional(),
  id: z.string(),
  username: z.string(),
});

const discordApiGuildMemberSchema = z.object({
  joined_at: z.string().nullable().optional(),
  nick: z.string().nullable().optional(),
  user: discordApiUserSchema.optional(),
});

const discordApiGuildSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export function createDiscordRestHistoryGateway(rest: Pick<REST, "get">): DiscordHistoryGateway {
  return {
    fetchChannelById: async (channelId) => {
      try {
        const rawChannel = await rest.get(Routes.channel(channelId));
        return parseDiscordChannel(rawChannel);
      } catch (error: unknown) {
        if (isSkippableDiscordRestError(error)) {
          return null;
        }
        throw error;
      }
    },
    fetchGuildMemberByUserId: async ({ guildId, userId }) => {
      try {
        const rawMember = await rest.get(Routes.guildMember(guildId, userId));
        return parseDiscordGuildMember(rawMember, guildId);
      } catch (error: unknown) {
        if (isSkippableDiscordRestError(error)) {
          return null;
        }
        throw error;
      }
    },
    fetchGuildById: async (guildId) => {
      try {
        const rawGuild = await rest.get(Routes.guild(guildId));
        return parseDiscordGuild(rawGuild);
      } catch (error: unknown) {
        if (isSkippableDiscordRestError(error)) {
          return null;
        }
        throw error;
      }
    },
    fetchMessages: async ({ beforeMessageId, channelId, limit }) => {
      const query = new URLSearchParams();
      query.set("limit", String(limit));
      if (beforeMessageId) {
        query.set("before", beforeMessageId);
      }

      const rawMessages = await rest.get(Routes.channelMessages(channelId), {
        query,
      });

      return parseDiscordMessages(rawMessages);
    },
    fetchUserById: async (userId) => {
      try {
        const rawUser = await rest.get(Routes.user(userId));
        return parseDiscordUser(rawUser);
      } catch (error: unknown) {
        if (isSkippableDiscordRestError(error)) {
          return null;
        }
        throw error;
      }
    },
  };
}

export function parseDiscordMessages(rawMessages: unknown): DiscordHistoryMessage[] {
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  const messages: DiscordHistoryMessage[] = [];
  for (const rawMessage of rawMessages) {
    const parsed = discordApiMessageSchema.safeParse(rawMessage);
    if (!parsed.success) {
      continue;
    }
    const message = parsed.data;

    const reactions = toRuntimeReactions(
      message.reactions.map((reaction) => {
        const emojiId = reaction.emoji.id;
        const emojiName = reaction.emoji.name;

        return {
          count: reaction.count,
          selfReacted: reaction.me,
          ...(emojiId !== undefined ? { emojiId } : {}),
          ...(emojiName !== undefined ? { emojiName } : {}),
        };
      }),
    );

    messages.push({
      attachments: message.attachments.map((attachment) => {
        return {
          id: attachment.id,
          name: attachment.filename,
          url: attachment.url,
        };
      }),
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      authorName: message.author.username,
      content: message.content,
      createdAt: message.timestamp,
      id: message.id,
      ...(reactions ? { reactions } : {}),
    });
  }

  return messages;
}

export function parseDiscordChannel(rawChannel: unknown): DiscordChannelSummary | null {
  const parsed = discordApiChannelSchema.safeParse(rawChannel);
  if (!parsed.success) {
    return null;
  }

  return {
    guildId: parsed.data.guild_id ?? null,
    id: parsed.data.id,
    name: parsed.data.name,
  };
}

export function parseDiscordGuild(rawGuild: unknown): DiscordGuildSummary | null {
  const parsed = discordApiGuildSchema.safeParse(rawGuild);
  if (!parsed.success) {
    return null;
  }

  return {
    id: parsed.data.id,
    name: parsed.data.name,
  };
}

export function parseDiscordUser(rawUser: unknown): DiscordUserDetail | null {
  const parsed = discordApiUserSchema.safeParse(rawUser);
  if (!parsed.success) {
    return null;
  }

  return {
    avatar: parsed.data.avatar ?? null,
    banner: parsed.data.banner ?? null,
    bot: parsed.data.bot,
    globalName: parsed.data.global_name ?? null,
    id: parsed.data.id,
    username: parsed.data.username,
  };
}

export function parseDiscordGuildMember(
  rawMember: unknown,
  guildId: string,
): DiscordGuildMemberDetail | null {
  const parsed = discordApiGuildMemberSchema.safeParse(rawMember);
  if (!parsed.success) {
    return null;
  }

  const user = parsed.data.user ? parseDiscordUser(parsed.data.user) : null;

  return {
    guildId,
    joinedAt: parsed.data.joined_at ?? null,
    nickname: parsed.data.nick ?? null,
    ...(user ? { user } : {}),
  };
}

function isSkippableDiscordRestError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const status = Reflect.get(error, "status");
  return status === 403 || status === 404;
}
