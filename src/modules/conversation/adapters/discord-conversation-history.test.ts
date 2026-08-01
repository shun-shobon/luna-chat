import { describe, expect, it, vi } from "vitest";

import type { DiscordMessage } from "../../discord/domain/discord-message";
import type { DiscordReadPort } from "../../discord/ports/discord-read-port";

import { DiscordConversationHistory } from "./discord-conversation-history";

describe("DiscordConversationHistory", () => {
  it("Discordの100件上限をcursor paginationして指定件数まで取得する", async () => {
    const readMessageHistory = vi
      .fn<DiscordReadPort["readMessageHistory"]>()
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => message(index + 101)))
      .mockResolvedValueOnce(Array.from({ length: 50 }, (_, index) => message(index + 51)));
    const history = new DiscordConversationHistory(createReadPort({ readMessageHistory }));

    const result = await history.fetchBefore(
      { kind: "guild_channel", guildId: "300", channelId: "200" },
      "201",
      150,
    );

    expect(readMessageHistory).toHaveBeenNthCalledWith(1, {
      beforeMessageId: "201",
      channelId: "200",
      limit: 100,
    });
    expect(readMessageHistory).toHaveBeenNthCalledWith(2, {
      beforeMessageId: "101",
      channelId: "200",
      limit: 50,
    });
    expect(result).toHaveLength(150);
    expect(result[0]?.id).toBe("51");
    expect(result.at(-1)?.id).toBe("200");
  });
});

function createReadPort(overrides: Partial<DiscordReadPort>): DiscordReadPort {
  return {
    getGuildEmoji: vi.fn(),
    getUserDetail: vi.fn(),
    listChannels: vi.fn(),
    listGuildEmojis: vi.fn(),
    readMessageHistory: vi.fn(),
    ...overrides,
  };
}

function message(id: number): DiscordMessage {
  return {
    id: String(id),
    timestamp: "2026-07-23T00:00:00.000Z",
    kind: "default",
    guild: { id: "300", name: "Luna Lab" },
    channel: { id: "200", name: "general" },
    author: { id: "100", kind: "human", username: "shun", displayName: "Shun" },
    content: String(id),
    attachments: [],
    stickers: [],
    reactions: [],
    mentions: { users: [], roles: [], channels: [], everyone: false },
    replyTo: null,
  };
}
