import type {
  DiscordGuildEmoji,
  DiscordHistoryGateway,
} from "../../ports/outbound/discord-history-gateway-port";

type GuildEmojiScope = {
  channelId?: string;
  guildId?: string;
};

export async function listGuildEmojisTool(
  input: {
    allowedChannelIds: ReadonlySet<string>;
    gateway: DiscordHistoryGateway;
  } & GuildEmojiScope,
): Promise<{
  emojis: DiscordGuildEmoji[];
  guildId: string | null;
}> {
  const guildId = await resolveScopedGuildId(input);
  if (!guildId) {
    return {
      emojis: [],
      guildId: null,
    };
  }

  return {
    emojis: await input.gateway.fetchGuildEmojis(guildId),
    guildId,
  };
}

export async function getGuildEmojiTool(
  input: {
    allowedChannelIds: ReadonlySet<string>;
    emojiId: string;
    gateway: DiscordHistoryGateway;
  } & GuildEmojiScope,
): Promise<{
  emoji: DiscordGuildEmoji | null;
}> {
  const guildIds = await resolveSearchGuildIds(input);

  for (const guildId of guildIds) {
    const emoji = await input.gateway.fetchGuildEmojiById({
      emojiId: input.emojiId,
      guildId,
    });
    if (emoji) {
      return {
        emoji,
      };
    }
  }

  return {
    emoji: null,
  };
}

async function resolveScopedGuildId(
  input: {
    allowedChannelIds: ReadonlySet<string>;
    gateway: DiscordHistoryGateway;
  } & GuildEmojiScope,
): Promise<string | null> {
  if (input.channelId !== undefined) {
    if (!input.allowedChannelIds.has(input.channelId)) {
      return null;
    }

    return (await input.gateway.fetchChannelById(input.channelId))?.guildId ?? null;
  }

  if (input.guildId !== undefined) {
    const allowedGuildIds = await resolveAllowedGuildIds(input);
    return allowedGuildIds.has(input.guildId) ? input.guildId : null;
  }

  return null;
}

async function resolveSearchGuildIds(
  input: {
    allowedChannelIds: ReadonlySet<string>;
    gateway: DiscordHistoryGateway;
  } & GuildEmojiScope,
): Promise<string[]> {
  const scopedGuildId = await resolveScopedGuildId(input);
  if (scopedGuildId) {
    return [scopedGuildId];
  }

  if (input.channelId !== undefined || input.guildId !== undefined) {
    return [];
  }

  return Array.from(await resolveAllowedGuildIds(input));
}

async function resolveAllowedGuildIds(input: {
  allowedChannelIds: ReadonlySet<string>;
  gateway: DiscordHistoryGateway;
}): Promise<Set<string>> {
  const guildIds = new Set<string>();

  for (const channelId of input.allowedChannelIds) {
    const channel = await input.gateway.fetchChannelById(channelId);
    if (channel?.guildId) {
      guildIds.add(channel.guildId);
    }
  }

  return guildIds;
}
