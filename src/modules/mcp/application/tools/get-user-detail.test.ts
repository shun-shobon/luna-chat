import { describe, expect, it, vi } from "vitest";

import type { DiscordHistoryGateway } from "../../adapters/outbound/discord/discord-rest-history-gateway";

import { getUserDetailTool } from "./get-user-detail";

describe("getUserDetailTool", () => {
  it("ユーザー情報と表示名/ニックネームを単一 user フィールドで返す", async () => {
    const fetchChannelById: DiscordHistoryGateway["fetchChannelById"] = vi.fn(
      async (channelId: string) => {
        if (channelId === "channel-1") {
          return {
            guildId: "guild-1",
            id: channelId,
            name: "general",
          };
        }
        return null;
      },
    );
    const fetchUserById: DiscordHistoryGateway["fetchUserById"] = vi.fn(async () => {
      return {
        avatar: null,
        banner: null,
        bot: false,
        globalName: "global-user",
        id: "user-1",
        username: "username",
      };
    });
    const fetchGuildMemberByUserId: DiscordHistoryGateway["fetchGuildMemberByUserId"] = vi.fn(
      async () => {
        return {
          guildId: "guild-1",
          joinedAt: "2026-01-01T00:00:00.000Z",
          nickname: "guild-nick",
        };
      },
    );

    const gateway = createGatewayStub({
      fetchChannelById,
      fetchGuildMemberByUserId,
      fetchUserById,
    });

    const payload = await getUserDetailTool({
      allowedChannelIds: new Set(["channel-1", "channel-2"]),
      channelId: "channel-1",
      gateway,
      userId: "user-1",
    });

    expect(payload).toMatchSnapshot();

    expect(fetchGuildMemberByUserId).toHaveBeenCalledTimes(1);
    expect(fetchGuildMemberByUserId).toHaveBeenCalledWith({
      guildId: "guild-1",
      userId: "user-1",
    });
  });

  it("nickname がないときは user の globalName / username で表示名を補完する", async () => {
    const gateway = createGatewayStub({
      fetchChannelById: vi.fn(async () => {
        return {
          guildId: "guild-1",
          id: "channel-1",
          name: "general",
        };
      }),
      fetchGuildMemberByUserId: vi.fn(async () => {
        return {
          guildId: "guild-1",
          joinedAt: null,
          nickname: null,
        };
      }),
      fetchUserById: vi.fn(async () => {
        return {
          avatar: null,
          banner: null,
          bot: false,
          globalName: "global-name",
          id: "user-1",
          username: "username",
        };
      }),
    });

    const payload = await getUserDetailTool({
      allowedChannelIds: new Set(["channel-1"]),
      channelId: "channel-1",
      gateway,
      userId: "user-1",
    });

    expect(payload).toMatchSnapshot();
  });

  it("許可外チャンネルでも user は返し、membership由来情報は空にする", async () => {
    const gateway = createGatewayStub({
      fetchUserById: vi.fn(async () => {
        return {
          avatar: null,
          banner: null,
          bot: false,
          globalName: "global-name",
          id: "user-1",
          username: "username",
        };
      }),
    });

    await expect(
      getUserDetailTool({
        allowedChannelIds: new Set(["channel-allowed"]),
        channelId: "channel-denied",
        gateway,
        userId: "user-1",
      }),
    ).resolves.toEqual({
      user: {
        avatar: null,
        banner: null,
        bot: false,
        displayName: "global-name",
        globalName: "global-name",
        id: "user-1",
        nickname: null,
        username: "username",
      },
    });
  });

  it("ユーザー未取得時は user=null を返す", async () => {
    const gateway = createGatewayStub({
      fetchUserById: vi.fn(async () => null),
    });

    await expect(
      getUserDetailTool({
        allowedChannelIds: new Set(["channel-allowed"]),
        channelId: "channel-allowed",
        gateway,
        userId: "user-1",
      }),
    ).resolves.toEqual({
      user: null,
    });
  });
});

function createGatewayStub(
  overrides: Partial<{
    [Key in keyof DiscordHistoryGateway]: DiscordHistoryGateway[Key];
  }> = {},
): DiscordHistoryGateway {
  const fetchMessages: DiscordHistoryGateway["fetchMessages"] = vi.fn(async () => []);
  const fetchChannelById: DiscordHistoryGateway["fetchChannelById"] = vi.fn(async () => null);
  const fetchGuildById: DiscordHistoryGateway["fetchGuildById"] = vi.fn(async () => null);
  const fetchUserById: DiscordHistoryGateway["fetchUserById"] = vi.fn(async () => null);
  const fetchGuildMemberByUserId: DiscordHistoryGateway["fetchGuildMemberByUserId"] = vi.fn(
    async () => null,
  );

  return {
    fetchChannelById: overrides.fetchChannelById ?? fetchChannelById,
    fetchGuildById: overrides.fetchGuildById ?? fetchGuildById,
    fetchGuildMemberByUserId: overrides.fetchGuildMemberByUserId ?? fetchGuildMemberByUserId,
    fetchMessages: overrides.fetchMessages ?? fetchMessages,
    fetchUserById: overrides.fetchUserById ?? fetchUserById,
  };
}
