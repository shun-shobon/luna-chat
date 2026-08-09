import { describe, expect, it, vi } from "vitest";

import {
  createDiscordConversationSession,
  createDiscordMessageEvent,
} from "../domain/discord-event";
import type { DiscordMessage } from "../domain/discord-message";
import type { DiscordReadPort } from "../ports/discord-read-port";

import { DiscordConversationHistory } from "./discord-conversation-history";

const scope = { kind: "guild_channel", guildId: "300", channelId: "200" } as const;

describe("DiscordConversationHistory", () => {
  it("Discordの100件上限をcursor paginationして同じLunaEvent形式へ変換する", async () => {
    const readMessageHistory = vi
      .fn<DiscordReadPort["readMessageHistory"]>()
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => message(index + 101)))
      .mockResolvedValueOnce(Array.from({ length: 50 }, (_, index) => message(index + 51)));
    const history = new DiscordConversationHistory(createReadPort({ readMessageHistory }));

    const result = await history.fetchBefore(
      createDiscordConversationSession(scope),
      createDiscordMessageEvent(scope, message(201)),
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
    expect(result[0]).toEqual(createDiscordMessageEvent(scope, message(51)));
    expect(result.at(-1)).toEqual(createDiscordMessageEvent(scope, message(200)));
  });

  it("session contextとbefore Eventを境界で検証する", async () => {
    const history = new DiscordConversationHistory(createReadPort({}));
    const before = createDiscordMessageEvent(scope, message(201));

    await expect(
      history.fetchBefore(
        { key: "discord:guild_channel:300:200", source: "discord/main", context: null },
        before,
        1,
      ),
    ).rejects.toThrow();
    await expect(
      history.fetchBefore(createDiscordConversationSession(scope), { ...before, id: "999" }, 1),
    ).rejects.toThrow("does not match");
    const otherScope = { kind: "guild_channel", guildId: "300", channelId: "999" } as const;
    await expect(
      history.fetchBefore(
        createDiscordConversationSession(scope),
        {
          ...createDiscordMessageEvent(otherScope, {
            ...message(201),
            channel: { id: "999", name: "other" },
          }),
          subject: "discord:guild_channel:300:200",
        },
        1,
      ),
    ).rejects.toThrow("scope does not match");
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
