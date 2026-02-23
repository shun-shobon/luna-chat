import type { Collection, Message, TextBasedChannel } from "discord.js";
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
      return new Map([
        ["2", secondMessage],
        ["1", firstMessage],
      ]) as unknown as Collection<string, Message>;
    });
    const channel = {
      id: "channel",
      messages: {
        fetch,
      },
    } as unknown as TextBasedChannel;

    const context = await fetchConversationContext({
      botUserId: "bot",
      channel,
      limit: 20,
      requestedByToolUse: false,
    });

    expect(fetch).toHaveBeenCalledWith({ limit: 20 });
    expect(context.channelId).toBe("channel");
    expect(context.recentMessages.map((message) => message.id)).toEqual(["1", "2"]);
    expect(context.recentMessages[1]?.mentionedBot).toBe(true);
  });
});

function createFakeMessage(input: {
  id: string;
  content: string;
  createdAt: Date;
  mentionBot: boolean;
}): Message {
  return {
    author: {
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
  } as unknown as Message;
}
