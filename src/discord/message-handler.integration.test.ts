import { Collection } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { AiService } from "../ai/ai-service";
import type {
  DiscordAttachmentInput,
  DiscordAttachmentStore,
} from "../attachments/discord-attachment-store";

import { handleMessageCreate, type MessageLike } from "./message-handler";

type AttachmentLike = {
  id: string;
  name?: string | null;
  url: string;
};

type HistoryMessageLike = {
  attachments?: Collection<string, AttachmentLike>;
  author: {
    bot: boolean;
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
  it("自分自身の投稿は無反応", async () => {
    const sendTyping = vi.fn(async () => undefined);
    const message = createMessage({
      authorId: "bot",
      authorIsBot: true,
      sendTyping,
    });
    const generateReply = vi.fn(async () => undefined);
    const aiService = createAiService(generateReply);
    const attachmentStore = createAttachmentStore();

    await handleMessageCreate({
      attachmentStore,
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      botUserId: "bot",
      logger: createLogger(),
      message,
    });

    expect(generateReply).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("他Botの投稿でも自分以外なら AI が呼び出される", async () => {
    const message = createMessage({
      authorId: "other-bot",
      authorIsBot: true,
      authorUsername: "other-bot",
    });
    const generateReply = vi.fn(async () => undefined);
    const aiService = createAiService(generateReply);
    const attachmentStore = createAttachmentStore();

    await handleMessageCreate({
      attachmentStore,
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      botUserId: "bot",
      logger: createLogger(),
      message,
    });

    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(generateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessage: expect.objectContaining({
          authorId: "other-bot",
          authorIsBot: true,
          authorName: "other-bot",
        }),
      }),
    );
  });

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
    const aiService = createAiService(generateReply);
    const attachmentStore = createAttachmentStore();

    await handleMessageCreate({
      attachmentStore,
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      botUserId: "bot",
      logger: createLogger(),
      message,
    });

    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(sendTyping).not.toHaveBeenCalled();
    expect(fetchHistory).toHaveBeenCalledWith({ before: "message", limit: 10 });
    expect(generateReply).toHaveBeenCalledWith({
      channelName: "general",
      currentMessage: {
        authorId: "author",
        authorIsBot: false,
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
          authorIsBot: false,
          authorName: "display",
          channelId: "channel",
          content: "history",
          createdAt: "2026-01-01 08:59:00 JST",
          id: "old",
          mentionedBot: false,
        },
        {
          authorId: "author",
          authorIsBot: false,
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
    const aiService = createAiService(
      vi.fn(async () => {
        throw new Error("ai failed");
      }),
    );
    const attachmentStore = createAttachmentStore();

    await handleMessageCreate({
      attachmentStore,
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
    const aiService = createAiService(generateReply);
    const attachmentStore = createAttachmentStore();

    await handleMessageCreate({
      attachmentStore,
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
    const aiService = createAiService(generateReply);
    const attachmentStore = createAttachmentStore();

    await handleMessageCreate({
      attachmentStore,
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

  it("Botメンション時はAI処理中の入力中表示を定期更新する", async () => {
    vi.useFakeTimers();
    try {
      const sendTyping = vi.fn(async () => undefined);
      const message = createMessage({ mentionBot: true, sendTyping });
      const aiService = createAiService(
        vi.fn(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 17_000);
          });
          return undefined;
        }),
      );
      const attachmentStore = createAttachmentStore();

      const handlePromise = handleMessageCreate({
        attachmentStore,
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

  it("Bot未メンション時はAI処理中でも入力中表示を送信しない", async () => {
    vi.useFakeTimers();
    try {
      const sendTyping = vi.fn(async () => undefined);
      const message = createMessage({ sendTyping });
      const aiService = createAiService(
        vi.fn(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 17_000);
          });
          return undefined;
        }),
      );
      const attachmentStore = createAttachmentStore();

      const handlePromise = handleMessageCreate({
        attachmentStore,
        aiService,
        allowedChannelIds: new Set(["allowed"]),
        botUserId: "bot",
        logger: createLogger(),
        message,
      });
      await vi.advanceTimersByTimeAsync(17_000);
      await handlePromise;

      expect(sendTyping).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("入力中表示送信に失敗してもAI呼び出しは継続する", async () => {
    const sendTyping = vi.fn(async () => {
      throw new Error("typing failed");
    });
    const message = createMessage({ mentionBot: true, sendTyping });
    const generateReply = vi.fn(async () => undefined);
    const logger = createLogger();
    const aiService = createAiService(generateReply);
    const attachmentStore = createAttachmentStore();

    await handleMessageCreate({
      attachmentStore,
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      botUserId: "bot",
      logger,
      message,
    });

    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("Failed to send typing indicator:", expect.any(Error));
  });

  it("添付ファイルがある場合は本文末尾に1行でマーカーを追記する", async () => {
    const message = createMessage({
      attachments: [
        {
          id: "a1",
          name: "cat.png",
          url: "https://example.com/cat.png",
        },
        {
          id: "a2",
          name: "dog.jpg",
          url: "https://example.com/dog.jpg",
        },
      ],
    });
    const generateReply = vi.fn(async () => undefined);
    const aiService = createAiService(generateReply);
    const attachmentStore = createAttachmentStore({
      pathsById: {
        a1: "/tmp/a1.png",
        a2: "/tmp/a2.jpg",
      },
    });

    await handleMessageCreate({
      attachmentStore,
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      botUserId: "bot",
      logger: createLogger(),
      message,
    });

    expect(generateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessage: expect.objectContaining({
          content: "hello?\n<attachment:/tmp/a1.png> <attachment:/tmp/a2.jpg>",
        }),
      }),
    );
  });

  it("添付保存が失敗しても本文は維持して処理を継続する", async () => {
    const message = createMessage({
      attachments: [
        {
          id: "a1",
          name: "cat.png",
          url: "https://example.com/cat.png",
        },
      ],
    });
    const generateReply = vi.fn(async () => undefined);
    const logger = createLogger();
    const aiService = createAiService(generateReply);
    const attachmentStore = createAttachmentStore({
      failIds: new Set(["a1"]),
    });

    await handleMessageCreate({
      attachmentStore,
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      botUserId: "bot",
      logger,
      message,
    });

    expect(generateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessage: expect.objectContaining({
          content: "hello?",
        }),
      }),
    );
    expect(logger.warn).toHaveBeenCalled();
  });
});

function createMessage(input?: {
  attachments?: AttachmentLike[];
  authorId?: string;
  authorIsBot?: boolean;
  authorUsername?: string;
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
      bot: input?.authorIsBot ?? false,
      id: input?.authorId ?? "author",
      username: input?.authorUsername ?? "author",
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
    attachments: createAttachmentCollection(input?.attachments ?? []),
  };
}

function createFakeHistoryMessage(input: { id: string; createdAt: Date }): HistoryMessageLike {
  return {
    author: {
      bot: false,
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
    attachments: createAttachmentCollection([]),
  };
}

function createAttachmentCollection(
  attachments: AttachmentLike[],
): Collection<string, AttachmentLike> {
  return new Collection<string, AttachmentLike>(
    attachments.map((attachment) => {
      return [attachment.id, attachment];
    }),
  );
}

function createAttachmentStore(input?: {
  failIds?: ReadonlySet<string>;
  pathsById?: Record<string, string>;
}): DiscordAttachmentStore {
  return {
    saveAttachment: vi.fn(async (attachment: DiscordAttachmentInput) => {
      if (input?.failIds?.has(attachment.id)) {
        throw new Error("save failed");
      }

      return input?.pathsById?.[attachment.id] ?? `/tmp/${attachment.id}`;
    }),
  };
}

function createAiService(generateReply: AiService["generateReply"]): AiService {
  return {
    generateHeartbeat: async () => undefined,
    generateReply,
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
