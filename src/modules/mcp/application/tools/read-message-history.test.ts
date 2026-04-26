import { describe, expect, it, vi } from "vitest";

import type { DiscordHistoryGateway } from "../../ports/outbound/discord-history-gateway-port";

import { readMessageHistory } from "./read-message-history";

describe("readMessageHistory", () => {
  it("返却ペイロードのスナップショット", async () => {
    const gateway = createGatewayStub({
      fetchMessages: vi.fn(async () => {
        const messages: Awaited<ReturnType<DiscordHistoryGateway["fetchMessages"]>> = [
          {
            attachments: [],
            authorId: "bot-1",
            authorIsBot: true,
            authorName: "ルナ",
            content: "新しいメッセージ",
            createdAt: "2026-01-01 09:01:00 JST",
            id: "m2",
            reactions: [
              {
                count: 2,
                emoji: "👍",
                selfReacted: true,
              },
            ],
          },
          {
            attachments: [
              {
                id: "att-1",
                name: "memo.txt",
                url: "https://example.com/memo.txt",
              },
            ],
            authorId: "user-1",
            authorIsBot: false,
            authorName: "Alice",
            content: "古いメッセージ",
            createdAt: "2026-01-01 09:00:00 JST",
            id: "m1",
          },
        ];

        return messages;
      }),
    });
    const payload = await readMessageHistory({
      channelId: "channel-1",
      gateway,
      limit: 30,
    });

    expect(payload).toMatchSnapshot();
  });

  it("afterMessageId を gateway へ渡す", async () => {
    const fetchMessages: DiscordHistoryGateway["fetchMessages"] = vi.fn(async () => []);
    const gateway = createGatewayStub({
      fetchMessages,
    });

    await readMessageHistory({
      afterMessageId: "message-after",
      channelId: "channel-1",
      gateway,
      limit: 30,
    });

    expect(fetchMessages).toHaveBeenCalledWith({
      afterMessageId: "message-after",
      channelId: "channel-1",
      limit: 30,
    });
  });

  it("aroundMessageId を gateway へ渡す", async () => {
    const fetchMessages: DiscordHistoryGateway["fetchMessages"] = vi.fn(async () => []);
    const gateway = createGatewayStub({
      fetchMessages,
    });

    await readMessageHistory({
      aroundMessageId: "message-around",
      channelId: "channel-1",
      gateway,
      limit: 30,
    });

    expect(fetchMessages).toHaveBeenCalledWith({
      aroundMessageId: "message-around",
      channelId: "channel-1",
      limit: 30,
    });
  });

  it("before/after/around を同時指定した場合はエラーにする", async () => {
    const gateway = createGatewayStub();

    await expect(
      readMessageHistory({
        afterMessageId: "after",
        aroundMessageId: "around",
        beforeMessageId: "before",
        channelId: "channel-1",
        gateway,
        limit: 30,
      }),
    ).rejects.toThrow(
      "beforeMessageId / afterMessageId / aroundMessageId は同時に指定できません。",
    );
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
