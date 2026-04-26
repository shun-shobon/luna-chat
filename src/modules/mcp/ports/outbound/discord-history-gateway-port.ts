import type { RuntimeReaction } from "../../../../shared/discord/runtime-reaction";
import type { RuntimeSticker } from "../../../../shared/discord/runtime-sticker";

export type DiscordHistoryMessage = {
  attachments: Array<{
    id: string;
    name: string | null;
    url: string;
  }>;
  authorId: string;
  authorIsBot: boolean;
  authorName: string;
  content: string;
  createdAt: string;
  id: string;
  reactions?: RuntimeReaction[];
  stickers?: RuntimeSticker[];
};

export type DiscordChannelSummary = {
  guildId: string | null;
  id: string;
  name: string;
};

export type DiscordUserDetail = {
  avatar: string | null;
  banner: string | null;
  bot: boolean;
  globalName: string | null;
  id: string;
  username: string;
};

export type DiscordGuildMemberDetail = {
  guildId: string;
  joinedAt: string | null;
  nickname: string | null;
  user?: DiscordUserDetail;
};

export type DiscordGuildSummary = {
  id: string;
  name: string;
};

export type DiscordGuildEmoji = {
  animated: boolean;
  guildId: string;
  id: string;
  mention: string;
  name: string;
  url: string;
};

export type DiscordHistoryGateway = {
  fetchChannelById: (channelId: string) => Promise<DiscordChannelSummary | null>;
  fetchGuildEmojiById: (input: {
    emojiId: string;
    guildId: string;
  }) => Promise<DiscordGuildEmoji | null>;
  fetchGuildEmojis: (guildId: string) => Promise<DiscordGuildEmoji[]>;
  fetchGuildById: (guildId: string) => Promise<DiscordGuildSummary | null>;
  fetchGuildMemberByUserId: (input: {
    guildId: string;
    userId: string;
  }) => Promise<DiscordGuildMemberDetail | null>;
  fetchMessages: (input: {
    afterMessageId?: string;
    aroundMessageId?: string;
    beforeMessageId?: string;
    channelId: string;
    limit: number;
  }) => Promise<DiscordHistoryMessage[]>;
  fetchUserById: (userId: string) => Promise<DiscordUserDetail | null>;
};
