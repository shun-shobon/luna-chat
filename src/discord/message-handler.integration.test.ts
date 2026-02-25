import { Collection } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { AiService } from "../ai/ai-service";

import { handleMessageCreate, type MessageLike } from "./message-handler";

type HistoryMessageLike = {
  author: {
    id: string;
    username: string;
  };
  channelId: string;
  content: string;
  createdAt: Date;
  createdTimestamp: number;
  id: string;
  member: {
    displayName: string;
  };
  mentions: {
    has: () => boolean;
  };
};

describe("handleMessageCreate integration", () => {
  it("指定チャンネルの通常投稿で AI が呼び出される", async () => {
    const reply = vi.fn(async () => undefined);
    const sendTyping = vi.fn(async () => undefined);
    const oldMessage = createFakeHistoryMessage({
      createdAt: new Date("2025-12-31T23:59:00.000Z"),
      id: "old",
    });
    const newMessage = createFakeHistoryMessage({
      createdAt: new Date("2025-12-31T23:59:30.000Z"),
      id: "new",
    });
    const fetchHistory = vi.fn(async () => {
      return new Collection<string, HistoryMessageLike>([
        ["new", newMessage],
        ["old", oldMessage],
      ]);
    });
    const message = createMessage({
      fetchHistory,
      reply,
      sendTyping,
    });
    const generateReply = vi.fn(async () => undefined);
    const aiService: AiService = {
      generateReply,
    };

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      botUserId: "bot",
      logger: createLogger(),
      message,
    });

    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(fetchHistory).toHaveBeenCalledWith({ before: "message", limit: 10 });
    expect(generateReply).toHaveBeenCalledWith({
      channelName: "general",
      currentMessage: {
        authorId: "author",
        authorName: "author",
        channelId: "allowed",
        content: "hello?",
        createdAt: "2026-01-01 09:00:00 JST",
        id: "message",
        mentionedBot: false,
      },
      recentMessages: [
        {
          authorId: "author",
          authorName: "display",
          channelId: "channel",
          content: "history",
          createdAt: "2026-01-01 08:59:00 JST",
          id: "old",
          mentionedBot: false,
        },
        {
          authorId: "author",
          authorName: "display",
          channelId: "channel",
          content: "history",
          createdAt: "2026-01-01 08:59:30 JST",
          id: "new",
          mentionedBot: false,
        },
      ],
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it("メンション投稿で AI が失敗してもフォールバック返信しない", async () => {
    const reply = vi.fn(async () => undefined);
    const logger = createLogger();
    const message = createMessage({
      mentionBot: true,
      reply,
    });
    const aiService: AiService = {
      generateReply: vi.fn(async () => {
        throw new Error("ai failed");
      }),
    };

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      botUserId: "bot",
      logger,
      message,
    });

    expect(reply).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("Failed to generate AI reply:", expect.any(Error));
  });

  it("指定外チャンネルは無反応", async () => {
    const reply = vi.fn(async () => undefined);
    const sendTyping = vi.fn(async () => undefined);
    const message = createMessage({ channelId: "other", reply, sendTyping });
    const generateReply = vi.fn(async () => undefined);
    const aiService: AiService = {
      generateReply,
    };

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      botUserId: "bot",
      logger: createLogger(),
      message,
    });

    expect(generateReply).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("履歴取得に失敗しても空履歴で AI を呼び出す", async () => {
    const fetchHistory = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    const message = createMessage({
      channelName: null,
      fetchHistory,
    });
    const generateReply = vi.fn(async () => undefined);
    const logger = createLogger();
    const aiService: AiService = {
      generateReply,
    };

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      botUserId: "bot",
      logger,
      message,
    });

    expect(generateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channelName: "unknown",
        recentMessages: [],
      }),
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it("AI処理中は入力中表示を定期更新する", async () => {
    vi.useFakeTimers();
    try {
      const sendTyping = vi.fn(async () => undefined);
      const message = createMessage({ sendTyping });
      const aiService: AiService = {
        generateReply: vi.fn(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 17_000);
          });
          return undefined;
        }),
      };

      const handlePromise = handleMessageCreate({
        aiService,
        allowedChannelIds: new Set(["allowed"]),
        botUserId: "bot",
        logger: createLogger(),
        message,
      });
      await vi.advanceTimersByTimeAsync(17_000);
      await handlePromise;

      expect(sendTyping).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("入力中表示送信に失敗してもAI呼び出しは継続する", async () => {
    const sendTyping = vi.fn(async () => {
      throw new Error("typing failed");
    });
    const message = createMessage({ sendTyping });
    const generateReply = vi.fn(async () => undefined);
    const logger = createLogger();
    const aiService: AiService = {
      generateReply,
    };

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      botUserId: "bot",
      logger,
      message,
    });

    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("Failed to send typing indicator:", expect.any(Error));
  });
});

function createMessage(input?: {
  channelId?: string;
  channelName?: string | null;
  fetchHistory?: (options: {
    before?: string;
    limit: number;
  }) => Promise<Collection<string, HistoryMessageLike>>;
  mentionBot?: boolean;
  reply?: MessageLike["reply"];
  sendTyping?: () => Promise<unknown>;
}): MessageLike {
  const channel: MessageLike["channel"] = {
    isThread: () => false,
    messages: {
      fetch:
        input?.fetchHistory ??
        vi.fn(async () => {
          return new Collection<string, HistoryMessageLike>();
        }),
    },
    name: input?.channelName === undefined ? "general" : input.channelName,
  };
  if (input?.sendTyping) {
    channel.sendTyping = input.sendTyping;
  }

  return {
    author: {
      bot: false,
      id: "author",
      username: "author",
    },
    channel,
    channelId: input?.channelId ?? "allowed",
    content: "hello?",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    createdTimestamp: new Date("2026-01-01T00:00:00.000Z").getTime(),
    id: "message",
    inGuild: () => true,
    mentions: {
      has: (userId: string) => {
        if (!input?.mentionBot) {
          return false;
        }
        return userId === "bot";
      },
    },
    reply: input?.reply ?? (async () => undefined),
  };
}

function createFakeHistoryMessage(input: { id: string; createdAt: Date }): HistoryMessageLike {
  return {
    author: {
      id: "author",
      username: "author",
    },
    channelId: "channel",
    content: "history",
    createdAt: input.createdAt,
    createdTimestamp: input.createdAt.getTime(),
    id: input.id,
    member: {
      displayName: "display",
    },
    mentions: {
      has: () => false,
    },
  };
}

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}
