import { describe, expect, it, vi } from "vitest";

import type { DiscordHistoryGateway } from "../../ports/outbound/discord-history-gateway-port";

import { listChannelsTool } from "./list-channels";

describe("listChannelsTool", () => {
  it("許可チャンネルのみを返し、取得失敗分はスキップする", async () => {
    const gateway = createGatewayStub({
      fetchChannelById: vi.fn(async (channelId: string) => {
        if (channelId === "channel-1") {
          return {
            guildId: "guild-1",
            id: "channel-1",
            name: "general",
          };
        }
        return null;
      }),
      fetchGuildById: vi.fn(async () => {
        return {
          id: "guild-1",
          name: "guild-name",
        };
      }),
    });

    const payload = await listChannelsTool({
      allowedChannelIds: new Set(["channel-1", "channel-2"]),
      gateway,
    });

    expect(payload).toMatchSnapshot();
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
