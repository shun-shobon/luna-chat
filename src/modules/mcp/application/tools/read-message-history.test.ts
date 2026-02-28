import { describe, expect, it, vi } from "vitest";

import type { DiscordHistoryGateway } from "../../ports/outbound/discord-history-gateway-port";

import { readMessageHistory, type AttachmentContentDecorator } from "./read-message-history";

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
            createdAt: "2026-01-01T00:01:00.000Z",
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
            createdAt: "2026-01-01T00:00:00.000Z",
            id: "m1",
          },
        ];

        return messages;
      }),
    });

    const decorator: AttachmentContentDecorator = async ({ attachments, content }) => {
      if (attachments.length === 0) {
        return content;
      }
      return `${content} <attachments:${attachments.map((attachment) => attachment.id).join(",")}>`;
    };

    const payload = await readMessageHistory({
      channelId: "channel-1",
      decorator: vi.fn(decorator),
      gateway,
      limit: 30,
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
