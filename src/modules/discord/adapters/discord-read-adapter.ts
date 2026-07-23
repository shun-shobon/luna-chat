import { ChannelType, type Client, type DMChannel, PermissionFlagsBits } from "discord.js";
import { z } from "zod";

import { discordIdSchema } from "../domain/discord-id";
import {
  discordChannelSummarySchema,
  discordGuildEmojiSchema,
  discordUserDetailSchema,
  type DiscordChannelSummary,
  type DiscordGuildEmoji,
  type DiscordReadPort,
  type DiscordUserDetail,
  type ReadMessageHistoryInput,
} from "../ports/discord-read-port";

import { toDiscordGatewayMessage } from "./discord-message-adapter";

const readHistoryInputSchema = z
  .strictObject({
    channelId: discordIdSchema,
    limit: z.number().int().min(1).max(100),
    beforeMessageId: discordIdSchema.optional(),
    afterMessageId: discordIdSchema.optional(),
    aroundMessageId: discordIdSchema.optional(),
  })
  .refine(
    (input) =>
      [input.beforeMessageId, input.afterMessageId, input.aroundMessageId].filter(
        (value) => value !== undefined,
      ).length <= 1,
    { message: "Only one Discord history cursor may be specified" },
  );

const getUserInputSchema = z.strictObject({
  userId: discordIdSchema,
  guildId: discordIdSchema.optional(),
});

export interface DiscordReadClient {
  fetchMessages(input: ReadMessageHistoryInput): Promise<readonly unknown[]>;
  listChannels(): Promise<unknown>;
  fetchUser(input: Readonly<{ userId: string; guildId?: string | undefined }>): Promise<unknown>;
  fetchGuildEmojis(guildId: string): Promise<unknown>;
  fetchGuildEmoji(input: Readonly<{ guildId: string; emojiId: string }>): Promise<unknown>;
}

export class DiscordReadAdapter implements DiscordReadPort {
  constructor(private readonly client: DiscordReadClient) {}

  async readMessageHistory(input: ReadMessageHistoryInput) {
    const validated = readHistoryInputSchema.parse(input);
    const messages = await this.client.fetchMessages(validated);
    return messages
      .map((message) => toDiscordGatewayMessage(message).message)
      .sort((left, right) =>
        left.timestamp === right.timestamp
          ? left.id.localeCompare(right.id)
          : left.timestamp.localeCompare(right.timestamp),
      );
  }

  async listChannels(): Promise<readonly DiscordChannelSummary[]> {
    const channels = z.array(discordChannelSummarySchema).parse(await this.client.listChannels());
    return channels.sort((left, right) =>
      channelSortKey(left).localeCompare(channelSortKey(right)),
    );
  }

  async getUserDetail(
    input: Readonly<{ userId: string; guildId?: string | undefined }>,
  ): Promise<DiscordUserDetail> {
    const validated = getUserInputSchema.parse(input);
    return discordUserDetailSchema.parse(await this.client.fetchUser(validated));
  }

  async listGuildEmojis(guildId: string): Promise<readonly DiscordGuildEmoji[]> {
    const validatedGuildId = discordIdSchema.parse(guildId);
    const emojis = z
      .array(discordGuildEmojiSchema)
      .parse(await this.client.fetchGuildEmojis(validatedGuildId));
    return emojis.sort((left, right) => left.name.localeCompare(right.name));
  }

  async getGuildEmoji(
    input: Readonly<{ guildId: string; emojiId: string }>,
  ): Promise<DiscordGuildEmoji> {
    const validated = z
      .strictObject({ guildId: discordIdSchema, emojiId: discordIdSchema })
      .parse(input);
    return discordGuildEmojiSchema.parse(await this.client.fetchGuildEmoji(validated));
  }
}

export function createDiscordReadClient(client: Client): DiscordReadClient {
  return {
    fetchMessages: async (input) => {
      const channel = await client.channels.fetch(input.channelId, { force: true });
      if (channel === null || !channel.isTextBased()) {
        throw new Error(`Discord channel does not provide message history: ${input.channelId}`);
      }
      const messages = await channel.messages.fetch({
        cache: false,
        limit: input.limit,
        ...(input.beforeMessageId === undefined ? {} : { before: input.beforeMessageId }),
        ...(input.afterMessageId === undefined ? {} : { after: input.afterMessageId }),
        ...(input.aroundMessageId === undefined ? {} : { around: input.aroundMessageId }),
      });
      return Array.from(messages.values());
    },
    listChannels: async () => {
      const lunaUser = client.user;
      if (lunaUser === null) throw new Error("Discord client is not authenticated");
      const guildSummaries = await client.guilds.fetch();
      const guildChannelGroups = await Promise.all(
        Array.from(guildSummaries.values()).map(async (guildSummary) => {
          const guild = await client.guilds.fetch(guildSummary.id);
          const [channels, activeThreads] = await Promise.all([
            guild.channels.fetch(),
            guild.channels.fetchActiveThreads(false),
          ]);
          const guildChannels = Array.from(channels.values()).flatMap((channel) => {
            if (
              channel === null ||
              !channel.isTextBased() ||
              channel.permissionsFor(lunaUser)?.has(PermissionFlagsBits.ViewChannel) !== true
            ) {
              return [];
            }
            return [
              {
                kind: "guild_channel",
                id: channel.id,
                guildId: guild.id,
                guildName: guild.name,
                name: channel.name,
              },
            ];
          });
          const threads = Array.from(activeThreads.threads.values())
            .filter(
              (thread) =>
                thread.permissionsFor(lunaUser)?.has(PermissionFlagsBits.ViewChannel) === true,
            )
            .map((thread) => ({
              kind: "guild_thread",
              id: thread.id,
              guildId: guild.id,
              guildName: guild.name,
              name: thread.name,
              parentChannelId: thread.parentId,
            }));
          return [...guildChannels, ...threads];
        }),
      );
      const directMessages = Array.from(client.channels.cache.values())
        .filter((channel): channel is DMChannel => channel.type === ChannelType.DM)
        .map((channel) => {
          const recipient = z
            .object({ id: discordIdSchema, username: z.string().min(1) })
            .parse(channel.recipient);
          return {
            kind: "dm",
            id: channel.id,
            recipientId: recipient.id,
            recipientUsername: recipient.username,
          };
        });
      return [...guildChannelGroups.flat(), ...directMessages];
    },
    fetchUser: async (input) => {
      const user = await client.users.fetch(input.userId, { force: true });
      const guildMember =
        input.guildId === undefined
          ? undefined
          : await client.guilds
              .fetch(input.guildId)
              .then(
                async (guild) => await guild.members.fetch({ force: true, user: input.userId }),
              );
      return {
        id: user.id,
        username: user.username,
        globalName: user.globalName,
        bot: user.bot,
        system: user.system,
        avatarUrl: user.displayAvatarURL({ size: 1024 }),
        bannerUrl: user.bannerURL({ size: 1024 }) ?? null,
        ...(guildMember === undefined
          ? {}
          : {
              guildMember: {
                guildId: guildMember.guild.id,
                displayName: guildMember.displayName,
                nickname: guildMember.nickname,
                joinedAt: guildMember.joinedAt?.toISOString() ?? null,
                avatarUrl: guildMember.displayAvatarURL({ size: 1024 }),
                bannerUrl: guildMember.displayBannerURL({ size: 1024 }),
              },
            }),
      };
    },
    fetchGuildEmojis: async (guildId) => {
      const guild = await client.guilds.fetch(guildId);
      const emojis = await guild.emojis.fetch();
      return Array.from(emojis.values()).map((emoji) => toGuildEmoji(guildId, emoji));
    },
    fetchGuildEmoji: async (input) => {
      const guild = await client.guilds.fetch(input.guildId);
      const emoji = await guild.emojis.fetch(input.emojiId, { force: true });
      return toGuildEmoji(input.guildId, emoji);
    },
  };
}

function toGuildEmoji(
  guildId: string,
  emoji: {
    id: string;
    name: string | null;
    animated: boolean | null;
    available: boolean | null;
    imageURL(options: Readonly<{ extension: "gif" | "webp" }>): string;
  },
): unknown {
  const name = z.string().min(1).parse(emoji.name);
  const animated = emoji.animated === true;
  return {
    id: emoji.id,
    guildId,
    name,
    animated,
    available: emoji.available === true,
    mention: animated ? `<a:${name}:${emoji.id}>` : `<:${name}:${emoji.id}>`,
    url: emoji.imageURL({ extension: animated ? "gif" : "webp" }),
  };
}

function channelSortKey(channel: DiscordChannelSummary): string {
  return channel.kind === "dm"
    ? `dm:${channel.recipientUsername}:${channel.id}`
    : `${channel.guildName}:${channel.name}:${channel.id}`;
}
