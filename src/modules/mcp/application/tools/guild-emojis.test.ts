import { describe, expect, it, vi } from "vitest";

import type { DiscordHistoryGateway } from "../../ports/outbound/discord-history-gateway-port";

import { getGuildEmojiTool, listGuildEmojisTool } from "./guild-emojis";

describe("guild emoji tools", () => {
  it("許可チャンネルの channelId からサーバー絵文字一覧を取得する", async () => {
    const gateway = createGateway({
      channelGuilds: {
        "channel-1": "guild-1",
      },
      emojis: {
        "guild-1": [
          {
            animated: false,
            guildId: "guild-1",
            id: "emoji-1",
            mention: "<:luna:emoji-1>",
            name: "luna",
            url: "https://cdn.discordapp.com/emojis/emoji-1.webp",
          },
        ],
      },
    });

    await expect(
      listGuildEmojisTool({
        allowedChannelIds: new Set(["channel-1"]),
        channelId: "channel-1",
        gateway,
      }),
    ).resolves.toEqual({
      emojis: [
        {
          animated: false,
          guildId: "guild-1",
          id: "emoji-1",
          mention: "<:luna:emoji-1>",
          name: "luna",
          url: "https://cdn.discordapp.com/emojis/emoji-1.webp",
        },
      ],
      guildId: "guild-1",
    });
  });

  it("guildId は許可チャンネルに紐づくサーバーの場合だけ使える", async () => {
    const gateway = createGateway({
      channelGuilds: {
        "channel-1": "guild-1",
      },
      emojis: {
        "guild-1": [],
        "guild-2": [
          {
            animated: false,
            guildId: "guild-2",
            id: "emoji-2",
            mention: "<:secret:emoji-2>",
            name: "secret",
            url: "https://cdn.discordapp.com/emojis/emoji-2.webp",
          },
        ],
      },
    });

    await expect(
      listGuildEmojisTool({
        allowedChannelIds: new Set(["channel-1"]),
        gateway,
        guildId: "guild-2",
      }),
    ).resolves.toEqual({
      emojis: [],
      guildId: null,
    });
    expect(gateway.fetchGuildEmojis).not.toHaveBeenCalled();
  });

  it("emojiId 指定はスコープ省略時に許可サーバーから検索する", async () => {
    const gateway = createGateway({
      channelGuilds: {
        "channel-1": "guild-1",
        "channel-2": "guild-2",
      },
      emojis: {
        "guild-1": [],
        "guild-2": [
          {
            animated: true,
            guildId: "guild-2",
            id: "emoji-2",
            mention: "<a:party:emoji-2>",
            name: "party",
            url: "https://cdn.discordapp.com/emojis/emoji-2.gif",
          },
        ],
      },
    });

    await expect(
      getGuildEmojiTool({
        allowedChannelIds: new Set(["channel-1", "channel-2"]),
        emojiId: "emoji-2",
        gateway,
      }),
    ).resolves.toEqual({
      emoji: {
        animated: true,
        guildId: "guild-2",
        id: "emoji-2",
        mention: "<a:party:emoji-2>",
        name: "party",
        url: "https://cdn.discordapp.com/emojis/emoji-2.gif",
      },
    });
  });

  it("絵文字が存在しない場合は null を返す", async () => {
    const gateway = createGateway({
      channelGuilds: {
        "channel-1": "guild-1",
      },
      emojis: {
        "guild-1": [],
      },
    });

    await expect(
      getGuildEmojiTool({
        allowedChannelIds: new Set(["channel-1"]),
        emojiId: "missing",
        gateway,
      }),
    ).resolves.toEqual({
      emoji: null,
    });
  });
});

function createGateway(input: {
  channelGuilds: Record<string, string>;
  emojis: Record<
    string,
    Array<{
      animated: boolean;
      guildId: string;
      id: string;
      mention: string;
      name: string;
      url: string;
    }>
  >;
}): DiscordHistoryGateway {
  return {
    fetchChannelById: vi.fn(async (channelId) => {
      const guildId = input.channelGuilds[channelId];
      if (!guildId) {
        return null;
      }

      return {
        guildId,
        id: channelId,
        name: "general",
      };
    }),
    fetchGuildById: vi.fn(async (guildId) => {
      return {
        id: guildId,
        name: `Guild ${guildId}`,
      };
    }),
    fetchGuildEmojiById: vi.fn(async ({ emojiId, guildId }) => {
      return input.emojis[guildId]?.find((emoji) => emoji.id === emojiId) ?? null;
    }),
    fetchGuildEmojis: vi.fn(async (guildId) => {
      return input.emojis[guildId] ?? [];
    }),
    fetchGuildMemberByUserId: vi.fn(async () => null),
    fetchMessages: vi.fn(async () => []),
    fetchUserById: vi.fn(async () => null),
  };
}
