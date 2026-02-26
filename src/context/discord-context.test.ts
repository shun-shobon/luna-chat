import { Collection, type Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { fetchConversationContext } from "./discord-context";

describe("fetchConversationContext", () => {
  it("Discord API モックから履歴を取得し、時系列順に整形する", async () => {
    const firstMessage = createFakeMessage({
      content: "old",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      id: "1",
      mentionBot: false,
    });
    const secondMessage = createFakeMessage({
      content: "new",
      createdAt: new Date("2026-01-01T00:00:01.000Z"),
      id: "2",
      mentionBot: true,
    });

    const fetch = vi.fn(async () => {
      return new Collection<string, Message>([
        ["2", secondMessage],
        ["1", firstMessage],
      ]);
    });
    const channel = {
      id: "channel",
      messages: {
        fetch,
      },
    };

    const context = await fetchConversationContext({
      botUserId: "bot",
      channel,
      limit: 20,
      requestedByToolUse: false,
    });

    expect(fetch).toHaveBeenCalledWith({ limit: 20 });
    expect(context.channelId).toBe("channel");
    expect(context.recentMessages.map((message) => message.id)).toEqual(["1", "2"]);
    expect(context.recentMessages[0]?.createdAt).toBe("2026-01-01 09:00:00 JST");
    expect(context.recentMessages[1]?.createdAt).toBe("2026-01-01 09:00:01 JST");
    expect(context.recentMessages[1]?.mentionedBot).toBe(true);
  });

  it("beforeMessageId が指定された場合は before を含めて履歴を取得する", async () => {
    const fetch = vi.fn(async () => {
      return new Collection<string, Message>();
    });
    const channel = {
      id: "channel",
      messages: {
        fetch,
      },
    };

    await fetchConversationContext({
      beforeMessageId: "before-id",
      botUserId: "bot",
      channel,
      limit: 20,
      requestedByToolUse: true,
    });

    expect(fetch).toHaveBeenCalledWith({ before: "before-id", limit: 20 });
  });

  it("リアクションがある場合は絵文字別情報を保持する", async () => {
    const message = createFakeMessage({
      id: "1",
      content: "hello",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      mentionBot: false,
      reactions: [
        {
          count: 3,
          emojiId: null,
          emojiName: "👍",
          me: true,
        },
        {
          count: 1,
          emojiId: null,
          emojiName: "🎉",
          me: false,
        },
      ],
    });
    const fetch = vi.fn(async () => {
      return new Collection<string, Message>([["1", message]]);
    });
    const channel = {
      id: "channel",
      messages: { fetch },
    };

    const context = await fetchConversationContext({
      botUserId: "bot",
      channel,
      limit: 20,
      requestedByToolUse: false,
    });

    expect(context.recentMessages[0]?.reactions).toEqual([
      {
        count: 1,
        emoji: "🎉",
      },
      {
        count: 3,
        emoji: "👍",
        selfReacted: true,
      },
    ]);
  });

  it("リアクションがない場合はフィールドを省略する", async () => {
    const message = createFakeMessage({
      id: "1",
      content: "hello",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      mentionBot: false,
      reactions: [],
    });
    const fetch = vi.fn(async () => {
      return new Collection<string, Message>([["1", message]]);
    });
    const channel = {
      id: "channel",
      messages: { fetch },
    };

    const context = await fetchConversationContext({
      botUserId: "bot",
      channel,
      limit: 20,
      requestedByToolUse: false,
    });

    expect(context.recentMessages[0]).not.toHaveProperty("reactions");
  });
});

function createFakeMessage(input: {
  id: string;
  content: string;
  createdAt: Date;
  mentionBot: boolean;
  reactions?: Array<{
    count: number;
    emojiId?: string | null;
    emojiName?: string | null;
    me: boolean;
  }>;
}): Message {
  return {
    author: {
      bot: false,
      id: "author",
      username: "author",
    },
    channelId: "channel",
    content: input.content,
    createdAt: input.createdAt,
    createdTimestamp: input.createdAt.getTime(),
    id: input.id,
    member: {
      displayName: "display",
    },
    mentions: {
      has: (userId: string) => input.mentionBot && userId === "bot",
    },
    reactions: {
      cache: new Collection(
        (input.reactions ?? []).map((reaction, index) => {
          return [
            String(index),
            {
              count: reaction.count,
              emoji: {
                id: reaction.emojiId ?? null,
                name: reaction.emojiName ?? null,
              },
              me: reaction.me,
            },
          ];
        }),
      ),
    },
  } as Message;
}
