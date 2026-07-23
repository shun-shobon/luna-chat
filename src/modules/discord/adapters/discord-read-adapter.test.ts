import { describe, expect, it, vi } from "vitest";

import { DiscordReadAdapter, type DiscordReadClient } from "./discord-read-adapter";

describe("DiscordReadAdapter", () => {
  it("cursor付きhistoryを取得し、検証後にtimestampとIDの昇順へ並べる", async () => {
    const fetchMessages = vi.fn(async () => [
      createMessage({ id: "102", createdAt: new Date("2026-07-23T01:01:00.000Z") }),
      createMessage({ id: "101", createdAt: new Date("2026-07-23T01:00:00.000Z") }),
    ]);
    const adapter = new DiscordReadAdapter(createClient({ fetchMessages }));

    const messages = await adapter.readMessageHistory({
      channelId: "300",
      limit: 20,
      beforeMessageId: "100",
    });

    expect(messages.map((message) => message.id)).toEqual(["101", "102"]);
    expect(fetchMessages).toHaveBeenCalledWith({
      channelId: "300",
      limit: 20,
      beforeMessageId: "100",
    });
  });

  it("複数cursorとDiscord上限外limitをAPI call前に拒否する", async () => {
    const fetchMessages = vi.fn<DiscordReadClient["fetchMessages"]>(async () => []);
    const client = createClient({ fetchMessages });
    const adapter = new DiscordReadAdapter(client);

    await expect(
      adapter.readMessageHistory({
        channelId: "300",
        limit: 101,
        beforeMessageId: "100",
        afterMessageId: "101",
      }),
    ).rejects.toThrow();
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it("channel、user、Guild emojiのSDK responseをstrictに検証する", async () => {
    const adapter = new DiscordReadAdapter(createClient());

    await expect(adapter.listChannels()).resolves.toEqual([
      {
        kind: "guild_channel",
        id: "300",
        guildId: "200",
        guildName: "Luna Lab",
        name: "general",
      },
    ]);
    await expect(adapter.getUserDetail({ userId: "400", guildId: "200" })).resolves.toMatchObject({
      id: "400",
      guildMember: { guildId: "200", displayName: "Shun" },
    });
    await expect(adapter.listGuildEmojis("200")).resolves.toEqual([EMOJI]);
    await expect(adapter.getGuildEmoji({ guildId: "200", emojiId: "500" })).resolves.toEqual(EMOJI);
  });

  it("不正なSDK responseを欠落扱いにせず失敗させる", async () => {
    const adapter = new DiscordReadAdapter(
      createClient({ listChannels: vi.fn(async () => [{ id: "not-snowflake" }]) }),
    );

    await expect(adapter.listChannels()).rejects.toThrow();
  });
});

const EMOJI = {
  id: "500",
  guildId: "200",
  name: "luna",
  animated: false,
  available: true,
  mention: "<:luna:500>",
  url: "https://cdn.discordapp.com/emojis/500.webp",
};

function createClient(overrides: Partial<DiscordReadClient> = {}): DiscordReadClient {
  return {
    fetchMessages: vi.fn(async () => []),
    listChannels: vi.fn(async () => [
      {
        kind: "guild_channel",
        id: "300",
        guildId: "200",
        guildName: "Luna Lab",
        name: "general",
      },
    ]),
    fetchUser: vi.fn(async () => ({
      id: "400",
      username: "shun",
      globalName: "Shun",
      bot: false,
      system: false,
      avatarUrl: "https://cdn.discordapp.com/avatar.png",
      bannerUrl: null,
      guildMember: {
        guildId: "200",
        displayName: "Shun",
        nickname: null,
        joinedAt: "2026-01-01T00:00:00.000Z",
        avatarUrl: "https://cdn.discordapp.com/avatar.png",
        bannerUrl: null,
      },
    })),
    fetchGuildEmojis: vi.fn(async () => [EMOJI]),
    fetchGuildEmoji: vi.fn(async () => EMOJI),
    ...overrides,
  };
}

function createMessage(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "100",
    createdAt: new Date("2026-07-23T01:00:00.000Z"),
    system: false,
    guild: { id: "200", name: "Luna Lab" },
    channel: {
      id: "300",
      name: "general",
      parentId: null,
      recipient: null,
      isThread: () => false,
      isDMBased: () => false,
    },
    author: {
      id: "400",
      username: "shun",
      globalName: "Shun",
      bot: false,
      system: false,
    },
    member: { displayName: "Shun" },
    webhookId: null,
    content: "hello",
    attachments: new Map(),
    stickers: new Map(),
    reactions: { cache: new Map() },
    mentions: {
      users: new Map(),
      roles: new Map(),
      channels: new Map(),
      everyone: false,
    },
    reference: null,
    ...overrides,
  };
}
