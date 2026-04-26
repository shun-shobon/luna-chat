import { formatDateTimeJst } from "../../../../../shared/discord/format-date-time-jst";
import { toRuntimeReactions } from "../../../../../shared/discord/runtime-reaction";
import type { RuntimeReaction } from "../../../../../shared/discord/runtime-reaction";
import type {
  DiscordChannelSummary,
  DiscordGuildEmoji,
  DiscordGuildMemberDetail,
  DiscordGuildSummary,
  DiscordHistoryGateway,
  DiscordHistoryMessage,
  DiscordUserDetail,
} from "../../../ports/outbound/discord-history-gateway-port";

type DiscordHistoryClient = {
  channels: {
    fetch: (
      channelId: string,
      options?: {
        force?: boolean;
      },
    ) => Promise<unknown>;
  };
  guilds: {
    fetch: (
      guildId: string,
      options?: {
        force?: boolean;
      },
    ) => Promise<unknown>;
  };
  users: {
    fetch: (
      userId: string,
      options?: {
        force?: boolean;
      },
    ) => Promise<unknown>;
  };
};

export function createDiscordRestHistoryGateway(
  client: DiscordHistoryClient,
): DiscordHistoryGateway {
  return {
    fetchChannelById: async (channelId) => {
      try {
        const channel = await client.channels.fetch(channelId, {
          force: true,
        });
        return toDiscordChannelSummary(channel);
      } catch (error: unknown) {
        if (isSkippableDiscordRestError(error)) {
          return null;
        }
        throw error;
      }
    },
    fetchGuildEmojiById: async ({ emojiId, guildId }) => {
      try {
        const guild = await client.guilds.fetch(guildId, {
          force: true,
        });
        if (!isGuildWithEmojiFetcher(guild)) {
          return null;
        }

        const emoji = await guild.emojis.fetch(emojiId, {
          force: true,
        });
        return toDiscordGuildEmoji(emoji, guildId);
      } catch (error: unknown) {
        if (isSkippableDiscordRestError(error)) {
          return null;
        }
        throw error;
      }
    },
    fetchGuildEmojis: async (guildId) => {
      try {
        const guild = await client.guilds.fetch(guildId, {
          force: true,
        });
        if (!isGuildWithEmojiFetcher(guild)) {
          return [];
        }

        const emojis = await guild.emojis.fetch();
        return toCollectionValues(emojis)
          .map((emoji) => toDiscordGuildEmoji(emoji, guildId))
          .filter((emoji): emoji is DiscordGuildEmoji => emoji !== null)
          .sort((left, right) => left.name.localeCompare(right.name, "ja"));
      } catch (error: unknown) {
        if (isSkippableDiscordRestError(error)) {
          return [];
        }
        throw error;
      }
    },
    fetchGuildMemberByUserId: async ({ guildId, userId }) => {
      try {
        const guild = await client.guilds.fetch(guildId, {
          force: true,
        });
        if (!isGuildWithMemberFetcher(guild)) {
          return null;
        }

        const member = await guild.members.fetch({
          force: true,
          user: userId,
        });
        return toDiscordGuildMemberDetail({
          guildId,
          member,
        });
      } catch (error: unknown) {
        if (isSkippableDiscordRestError(error)) {
          return null;
        }
        throw error;
      }
    },
    fetchGuildById: async (guildId) => {
      try {
        const guild = await client.guilds.fetch(guildId, {
          force: true,
        });
        return toDiscordGuildSummary(guild);
      } catch (error: unknown) {
        if (isSkippableDiscordRestError(error)) {
          return null;
        }
        throw error;
      }
    },
    fetchMessages: async ({
      afterMessageId,
      aroundMessageId,
      beforeMessageId,
      channelId,
      limit,
    }) => {
      const channel = await client.channels.fetch(channelId, {
        force: true,
      });
      if (!isHistoryReadableChannel(channel)) {
        return [];
      }

      const fetchedMessages = await channel.messages.fetch({
        cache: false,
        limit,
        before: beforeMessageId,
        after: afterMessageId,
        around: aroundMessageId,
      });
      const rawMessages = toCollectionValues(fetchedMessages);
      const normalizedMessages = rawMessages
        .map(toDiscordHistoryMessage)
        .filter((message): message is DiscordHistoryMessageWithTimestamp => message !== null)
        .sort((left, right) => right.createdTimestamp - left.createdTimestamp)
        .map((message) => message.message);

      return normalizedMessages;
    },
    fetchUserById: async (userId) => {
      try {
        const user = await client.users.fetch(userId, {
          force: true,
        });
        return toDiscordUserDetail(user);
      } catch (error: unknown) {
        if (isSkippableDiscordRestError(error)) {
          return null;
        }
        throw error;
      }
    },
  };
}

type DiscordHistoryMessageWithTimestamp = {
  createdTimestamp: number;
  message: DiscordHistoryMessage;
};

function toCollectionValues(input: unknown): unknown[] {
  if (typeof input !== "object" || input === null) {
    return [];
  }

  const values = Reflect.get(input, "values");
  if (typeof values !== "function") {
    return [];
  }

  return Array.from(values.call(input) as Iterable<unknown>);
}

function toDiscordChannelSummary(channel: unknown): DiscordChannelSummary | null {
  if (typeof channel !== "object" || channel === null) {
    return null;
  }

  const id = Reflect.get(channel, "id");
  const name = Reflect.get(channel, "name");
  if (typeof id !== "string" || typeof name !== "string") {
    return null;
  }

  const guildId = Reflect.get(channel, "guildId");
  return {
    guildId: typeof guildId === "string" ? guildId : null,
    id,
    name,
  };
}

function toDiscordGuildSummary(guild: unknown): DiscordGuildSummary | null {
  if (typeof guild !== "object" || guild === null) {
    return null;
  }

  const id = Reflect.get(guild, "id");
  const name = Reflect.get(guild, "name");
  if (typeof id !== "string" || typeof name !== "string") {
    return null;
  }

  return {
    id,
    name,
  };
}

function isGuildWithEmojiFetcher(guild: unknown): guild is {
  emojis: {
    fetch: (
      emojiId?: string,
      options?: {
        force?: boolean;
      },
    ) => Promise<unknown>;
  };
} {
  if (typeof guild !== "object" || guild === null) {
    return false;
  }

  const emojis = Reflect.get(guild, "emojis");
  if (typeof emojis !== "object" || emojis === null) {
    return false;
  }

  return typeof Reflect.get(emojis, "fetch") === "function";
}

function toDiscordGuildEmoji(rawEmoji: unknown, guildId: string): DiscordGuildEmoji | null {
  if (typeof rawEmoji !== "object" || rawEmoji === null) {
    return null;
  }

  const id = Reflect.get(rawEmoji, "id");
  const name = Reflect.get(rawEmoji, "name");
  if (typeof id !== "string" || typeof name !== "string") {
    return null;
  }

  const animated = Reflect.get(rawEmoji, "animated") === true;
  const mention = animated ? `<a:${name}:${id}>` : `<:${name}:${id}>`;

  return {
    animated,
    guildId,
    id,
    mention,
    name,
    url: resolveGuildEmojiUrl(rawEmoji, id, animated),
  };
}

function resolveGuildEmojiUrl(rawEmoji: object, emojiId: string, animated: boolean): string {
  const imageUrl = Reflect.get(rawEmoji, "imageURL");
  if (typeof imageUrl === "function") {
    const resolved = imageUrl.call(rawEmoji, {
      extension: animated ? "gif" : "webp",
    });
    if (typeof resolved === "string" && resolved.length > 0) {
      return resolved;
    }
  }

  return `https://cdn.discordapp.com/emojis/${emojiId}.${animated ? "gif" : "webp"}`;
}

function toDiscordUserDetail(rawUser: unknown): DiscordUserDetail | null {
  if (typeof rawUser !== "object" || rawUser === null) {
    return null;
  }

  const id = Reflect.get(rawUser, "id");
  const username = Reflect.get(rawUser, "username");
  if (typeof id !== "string" || typeof username !== "string") {
    return null;
  }

  const avatar = Reflect.get(rawUser, "avatar");
  const banner = Reflect.get(rawUser, "banner");
  const bot = Reflect.get(rawUser, "bot");
  const globalName = Reflect.get(rawUser, "globalName");

  return {
    avatar: typeof avatar === "string" ? avatar : null,
    banner: typeof banner === "string" ? banner : null,
    bot: bot === true,
    globalName: typeof globalName === "string" ? globalName : null,
    id,
    username,
  };
}

function isGuildWithMemberFetcher(guild: unknown): guild is {
  members: {
    fetch: (input: { force: boolean; user: string }) => Promise<unknown>;
  };
} {
  if (typeof guild !== "object" || guild === null) {
    return false;
  }

  const members = Reflect.get(guild, "members");
  if (typeof members !== "object" || members === null) {
    return false;
  }

  return typeof Reflect.get(members, "fetch") === "function";
}

function toDiscordGuildMemberDetail(input: {
  guildId: string;
  member: unknown;
}): DiscordGuildMemberDetail | null {
  if (typeof input.member !== "object" || input.member === null) {
    return null;
  }

  const joinedAt = Reflect.get(input.member, "joinedAt");
  const nickname = Reflect.get(input.member, "nickname");
  const user = toDiscordUserDetail(Reflect.get(input.member, "user"));

  return {
    guildId: input.guildId,
    joinedAt: joinedAt instanceof Date ? joinedAt.toISOString() : null,
    nickname: typeof nickname === "string" ? nickname : null,
    user: user ?? undefined,
  };
}

function isHistoryReadableChannel(channel: unknown): channel is {
  messages: {
    fetch: (input: {
      after?: string;
      around?: string;
      before?: string;
      cache: false;
      limit: number;
    }) => Promise<unknown>;
  };
} {
  if (typeof channel !== "object" || channel === null) {
    return false;
  }

  const isTextBased = Reflect.get(channel, "isTextBased");
  if (typeof isTextBased !== "function" || isTextBased.call(channel) !== true) {
    return false;
  }

  const messages = Reflect.get(channel, "messages");
  if (typeof messages !== "object" || messages === null) {
    return false;
  }

  return typeof Reflect.get(messages, "fetch") === "function";
}

function toDiscordHistoryMessage(rawMessage: unknown): DiscordHistoryMessageWithTimestamp | null {
  if (typeof rawMessage !== "object" || rawMessage === null) {
    return null;
  }

  const id = Reflect.get(rawMessage, "id");
  const content = Reflect.get(rawMessage, "content");
  const createdAt = Reflect.get(rawMessage, "createdAt");
  const createdTimestamp = Reflect.get(rawMessage, "createdTimestamp");
  const author = Reflect.get(rawMessage, "author");

  if (
    typeof id !== "string" ||
    typeof content !== "string" ||
    !(createdAt instanceof Date) ||
    typeof createdTimestamp !== "number" ||
    typeof author !== "object" ||
    author === null
  ) {
    return null;
  }

  const authorId = Reflect.get(author, "id");
  const authorIsBot = Reflect.get(author, "bot");
  const authorName = Reflect.get(author, "username");

  if (typeof authorId !== "string" || typeof authorName !== "string") {
    return null;
  }

  const attachments = toDiscordAttachments(Reflect.get(rawMessage, "attachments"));
  const reactions = toDiscordReactions(Reflect.get(rawMessage, "reactions"));

  return {
    createdTimestamp,
    message: {
      attachments,
      authorId,
      authorIsBot: authorIsBot === true,
      authorName,
      content,
      createdAt: formatDateTimeJst(createdAt),
      id,
      reactions,
    },
  };
}

function toDiscordAttachments(rawAttachments: unknown): DiscordHistoryMessage["attachments"] {
  const normalized: DiscordHistoryMessage["attachments"] = [];
  for (const rawAttachment of toCollectionValues(rawAttachments)) {
    if (typeof rawAttachment !== "object" || rawAttachment === null) {
      continue;
    }

    const id = Reflect.get(rawAttachment, "id");
    const url = Reflect.get(rawAttachment, "url");
    const name = Reflect.get(rawAttachment, "name");
    if (typeof id !== "string" || typeof url !== "string") {
      continue;
    }

    normalized.push({
      id,
      name: typeof name === "string" ? name : null,
      url,
    });
  }

  return normalized;
}

function toDiscordReactions(rawReactions: unknown): RuntimeReaction[] | undefined {
  const normalizedInput = toCollectionValues(rawReactions)
    .map((reaction) => {
      if (typeof reaction !== "object" || reaction === null) {
        return null;
      }

      const count = Reflect.get(reaction, "count");
      if (typeof count !== "number") {
        return null;
      }

      const me = Reflect.get(reaction, "me");
      const emoji = Reflect.get(reaction, "emoji");
      if (typeof emoji !== "object" || emoji === null) {
        return null;
      }

      const emojiId = Reflect.get(emoji, "id");
      const emojiName = Reflect.get(emoji, "name");

      const normalizedReaction: {
        count: number;
        emojiId?: string;
        emojiName?: string;
        selfReacted: boolean;
      } = {
        count,
        selfReacted: me === true,
      };
      if (typeof emojiId === "string") {
        normalizedReaction.emojiId = emojiId;
      }
      if (typeof emojiName === "string") {
        normalizedReaction.emojiName = emojiName;
      }

      return normalizedReaction;
    })
    .filter((reaction): reaction is NonNullable<typeof reaction> => reaction !== null);

  return toRuntimeReactions(normalizedInput);
}

function isSkippableDiscordRestError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const status = Reflect.get(error, "status");
  return status === 403 || status === 404;
}
