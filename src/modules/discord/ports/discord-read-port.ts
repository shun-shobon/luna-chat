import { z } from "zod";

import { discordIdSchema } from "../domain/discord-id";
import type { DiscordMessage } from "../domain/discord-message";

export const discordChannelSummarySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("guild_channel"),
    id: discordIdSchema,
    guildId: discordIdSchema,
    guildName: z.string().min(1),
    name: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("guild_thread"),
    id: discordIdSchema,
    guildId: discordIdSchema,
    guildName: z.string().min(1),
    name: z.string().min(1),
    parentChannelId: discordIdSchema,
  }),
  z.strictObject({
    kind: z.literal("dm"),
    id: discordIdSchema,
    recipientId: discordIdSchema,
    recipientUsername: z.string().min(1),
  }),
]);

const discordGuildMemberDetailSchema = z.strictObject({
  guildId: discordIdSchema,
  displayName: z.string().min(1),
  nickname: z.string().min(1).nullable(),
  joinedAt: z.iso.datetime({ offset: true }).nullable(),
  avatarUrl: z.url().nullable(),
  bannerUrl: z.url().nullable(),
});

export const discordUserDetailSchema = z.strictObject({
  id: discordIdSchema,
  username: z.string().min(1),
  globalName: z.string().min(1).nullable(),
  bot: z.boolean(),
  system: z.boolean(),
  avatarUrl: z.url().nullable(),
  bannerUrl: z.url().nullable(),
  guildMember: discordGuildMemberDetailSchema.optional(),
});

export const discordGuildEmojiSchema = z.strictObject({
  id: discordIdSchema,
  guildId: discordIdSchema,
  name: z.string().min(1),
  animated: z.boolean(),
  available: z.boolean(),
  mention: z.string().min(1),
  url: z.url(),
});

export type DiscordChannelSummary = z.infer<typeof discordChannelSummarySchema>;
export type DiscordUserDetail = z.infer<typeof discordUserDetailSchema>;
export type DiscordGuildEmoji = z.infer<typeof discordGuildEmojiSchema>;

export type ReadMessageHistoryInput = Readonly<{
  channelId: string;
  limit: number;
  beforeMessageId?: string | undefined;
  afterMessageId?: string | undefined;
  aroundMessageId?: string | undefined;
}>;

export interface DiscordReadPort {
  readMessageHistory(input: ReadMessageHistoryInput): Promise<readonly DiscordMessage[]>;
  listChannels(): Promise<readonly DiscordChannelSummary[]>;
  getUserDetail(
    input: Readonly<{ userId: string; guildId?: string | undefined }>,
  ): Promise<DiscordUserDetail>;
  listGuildEmojis(guildId: string): Promise<readonly DiscordGuildEmoji[]>;
  getGuildEmoji(input: Readonly<{ guildId: string; emojiId: string }>): Promise<DiscordGuildEmoji>;
}
