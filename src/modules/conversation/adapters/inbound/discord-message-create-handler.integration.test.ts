import { Collection } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  handleMessageCreate,
  type MessageLike,
  type ReplyGenerator,
} from "./discord-message-create-handler";

type AttachmentLike = {
  id: string;
  name?: string | null;
  url: string;
};

type ReactionLike = {
  count: number;
  emojiId?: string | null;
  emojiName?: string | null;
  me: boolean;
};

type StickerLike = {
  id: string;
  name: string;
  description?: string | null;
  format?: number | string | null;
  url?: string | null;
  guildId?: string | null;
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
  reactions: {
    cache: Collection<
      string,
      {
        count: number;
        emoji: {
          id?: string | null;
          name?: string | null;
        };
        me: boolean;
      }
    >;
  };
  stickers?: Collection<string, StickerLike>;
  reference?: {
    messageId?: string | null;
  } | null;
  fetchReference?: () => Promise<HistoryMessageLike>;
};

describe("handleMessageCreate integration", () => {
  it("自分自身の投稿は無反応", async () => {
    const sendTyping = vi.fn(async () => undefined);
    const message = createMessage({
      authorId: "bot",
      authorIsBot: true,
      sendTyping,
    });
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
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
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
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
      stickers: [
        {
          description: "old sticker",
          format: 1,
          guildId: "guild-1",
          id: "sticker-old",
          name: "old-sticker",
          url: "https://media.discordapp.net/stickers/sticker-old.png",
        },
      ],
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
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
      botUserId: "bot",
      logger: createLogger(),
      message,
    });

    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(sendTyping).not.toHaveBeenCalled();
    const aiInput = generateReply.mock.calls[0]?.[0];
    if (!aiInput) {
      throw new Error("generateReply was not called.");
    }

    expect(fetchHistory).not.toHaveBeenCalled();
    expect(aiInput).toEqual({
      context: {
        kind: "channel",
        channelName: "general",
      },
      currentMessage: {
        authorId: "author",
        authorIsBot: false,
        authorName: "author",
        attachments: [],
        channelId: "allowed",
        content: "hello?",
        createdAt: "2026-01-01 09:00:00 JST",
        id: "message",
        mentionedBot: false,
      },
      loadRecentMessages: expect.any(Function),
    });
    await expect(aiInput.loadRecentMessages()).resolves.toEqual([
      {
        authorId: "author",
        authorIsBot: false,
        authorName: "display",
        attachments: [],
        channelId: "channel",
        content: "history",
        createdAt: "2026-01-01 08:59:00 JST",
        id: "old",
        mentionedBot: false,
        stickers: [
          {
            description: "old sticker",
            format: "png",
            guildId: "guild-1",
            id: "sticker-old",
            name: "old-sticker",
            url: "https://media.discordapp.net/stickers/sticker-old.png",
          },
        ],
      },
      {
        authorId: "author",
        authorIsBot: false,
        authorName: "display",
        attachments: [],
        channelId: "channel",
        content: "history",
        createdAt: "2026-01-01 08:59:30 JST",
        id: "new",
        mentionedBot: false,
      },
    ]);
    expect(fetchHistory).toHaveBeenCalledWith({ before: "message", limit: 10 });
    expect(reply).not.toHaveBeenCalled();
  });

  it("DM は無反応", async () => {
    const sendTyping = vi.fn(async () => undefined);
    const message = createMessage({
      inGuild: false,
      sendTyping,
    });
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
      botUserId: "bot",
      logger: createLogger(),
      message,
    });

    expect(generateReply).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("DM 応答を有効化した場合は AI が呼び出される", async () => {
    const message = createMessage({
      inGuild: false,
    });
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: true,
      botUserId: "bot",
      logger: createLogger(),
      message,
    });

    expect(generateReply).toHaveBeenCalledTimes(1);
    const aiInput = generateReply.mock.calls[0]?.[0];
    if (!aiInput) {
      throw new Error("generateReply was not called.");
    }
    expect(aiInput.context).toEqual({
      kind: "dm",
    });
  });

  it("スレッド投稿は無反応", async () => {
    const sendTyping = vi.fn(async () => undefined);
    const message = createMessage({
      isThread: true,
      sendTyping,
    });
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
      botUserId: "bot",
      logger: createLogger(),
      message,
    });

    expect(generateReply).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalled();
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

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
      botUserId: "bot",
      logger,
      message,
    });

    expect(reply).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("Failed to generate AI reply:", expect.any(Error));
  });

  it("返信投稿では返信先情報を含めて AI が呼び出される", async () => {
    const referencedMessage = createFakeHistoryMessage({
      authorDisplayName: "reply-target-display",
      authorId: "reply-target-author-id",
      authorUsername: "reply-target-username",
      content: "reply target content",
      createdAt: new Date("2025-12-31T23:58:00.000Z"),
      id: "reply-target-id",
    });
    const message = createMessage({
      referenceMessage: referencedMessage,
    });
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
      botUserId: "bot",
      logger: createLogger(),
      message,
    });

    expect(generateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessage: expect.objectContaining({
          replyTo: {
            authorId: "reply-target-author-id",
            authorIsBot: false,
            authorName: "reply-target-display",
            attachments: [],
            content: "reply target content",
            createdAt: "2026-01-01 08:58:00 JST",
            id: "reply-target-id",
          },
        }),
      }),
    );
  });

  it("履歴メッセージが返信の場合も返信先情報を含める", async () => {
    const replyTarget = createFakeHistoryMessage({
      authorDisplayName: "history-reply-target-display",
      authorId: "history-reply-target-author-id",
      content: "history reply target",
      createdAt: new Date("2025-12-31T23:57:00.000Z"),
      id: "history-reply-target-id",
    });
    const historyReply = createFakeHistoryMessage({
      createdAt: new Date("2025-12-31T23:59:00.000Z"),
      id: "history-reply",
      referenceMessage: replyTarget,
    });
    const fetchHistory = vi.fn(async () => {
      return new Collection<string, HistoryMessageLike>([["history-reply", historyReply]]);
    });
    const message = createMessage({ fetchHistory });
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
      botUserId: "bot",
      logger: createLogger(),
      message,
    });

    const aiInput = generateReply.mock.calls[0]?.[0];
    if (!aiInput) {
      throw new Error("generateReply was not called.");
    }
    await expect(aiInput.loadRecentMessages()).resolves.toEqual([
      expect.objectContaining({
        id: "history-reply",
        replyTo: {
          authorId: "history-reply-target-author-id",
          authorIsBot: false,
          authorName: "history-reply-target-display",
          attachments: [],
          content: "history reply target",
          createdAt: "2026-01-01 08:57:00 JST",
          id: "history-reply-target-id",
        },
      }),
    ]);
  });

  it("返信先取得に失敗しても処理を継続する", async () => {
    const fetchReference = vi.fn(async () => {
      throw new Error("fetch reference failed");
    });
    const message = createMessage({
      fetchReference,
      referenceMessageId: "reply-target-id",
    });
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const logger = createLogger();
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
      botUserId: "bot",
      logger,
      message,
    });

    expect(generateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessage: expect.not.objectContaining({
          replyTo: expect.anything(),
        }),
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to fetch referenced message:",
      expect.objectContaining({
        referencedMessageId: "reply-target-id",
      }),
    );
  });

  it("指定外チャンネルは無反応", async () => {
    const reply = vi.fn(async () => undefined);
    const sendTyping = vi.fn(async () => undefined);
    const message = createMessage({ channelId: "other", reply, sendTyping });
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
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
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const logger = createLogger();
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
      botUserId: "bot",
      logger,
      message,
    });

    const aiInput = generateReply.mock.calls[0]?.[0];
    if (!aiInput) {
      throw new Error("generateReply was not called.");
    }
    expect(aiInput.context).toEqual({
      kind: "channel",
      channelName: "unknown",
    });
    await expect(aiInput.loadRecentMessages()).resolves.toEqual([]);
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

      const handlePromise = handleMessageCreate({
        aiService,
        allowedChannelIds: new Set(["allowed"]),
        allowDm: false,
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

      const handlePromise = handleMessageCreate({
        aiService,
        allowedChannelIds: new Set(["allowed"]),
        allowDm: false,
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
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const logger = createLogger();
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
      botUserId: "bot",
      logger,
      message,
    });

    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("Failed to send typing indicator:", expect.any(Error));
  });

  it("添付ファイルがある場合は本文と分離して AI 入力に含める", async () => {
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
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
      botUserId: "bot",
      logger: createLogger(),
      message,
    });

    expect(generateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessage: expect.objectContaining({
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
          content: "hello?",
        }),
      }),
    );
  });

  it("添付ファイルがあってもダウンロードせず処理を継続する", async () => {
    const message = createMessage({
      attachments: [
        {
          id: "a1",
          name: "cat.png",
          url: "https://example.com/cat.png",
        },
      ],
    });
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const logger = createLogger();
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
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
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("ステッカーだけの投稿でもステッカー情報を AI 入力に含める", async () => {
    const message = createMessage({
      content: "",
      referenceMessage: createFakeHistoryMessage({
        content: "",
        createdAt: new Date("2025-12-31T23:58:00.000Z"),
        id: "reply-target-id",
        stickers: [
          {
            description: "reply sticker",
            format: "lottie",
            guildId: "guild-1",
            id: "reply-sticker",
            name: "reply-lottie",
            url: "https://media.discordapp.net/stickers/reply-sticker.json",
          },
        ],
      }),
      stickers: [
        {
          description: "current sticker",
          format: 4,
          guildId: "guild-1",
          id: "current-sticker",
          name: "current-gif",
          url: "https://media.discordapp.net/stickers/current-sticker.gif",
        },
      ],
    });
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
      botUserId: "bot",
      logger: createLogger(),
      message,
    });

    expect(generateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessage: expect.objectContaining({
          content: "",
          stickers: [
            {
              description: "current sticker",
              format: "gif",
              guildId: "guild-1",
              id: "current-sticker",
              name: "current-gif",
              url: "https://media.discordapp.net/stickers/current-sticker.gif",
            },
          ],
          replyTo: expect.objectContaining({
            content: "",
            stickers: [
              {
                description: "reply sticker",
                format: "lottie",
                guildId: "guild-1",
                id: "reply-sticker",
                name: "reply-lottie",
                url: "https://media.discordapp.net/stickers/reply-sticker.json",
              },
            ],
          }),
        }),
      }),
    );
  });

  it("リアクションがある場合は絵文字別情報を AI 入力に含める", async () => {
    const message = createMessage({
      reactions: [
        {
          count: 3,
          emojiName: "👍",
          me: true,
        },
        {
          count: 1,
          emojiName: "🎉",
          me: false,
        },
      ],
      referenceMessage: createFakeHistoryMessage({
        createdAt: new Date("2025-12-31T23:58:00.000Z"),
        id: "reply-target-id",
        reactions: [
          {
            count: 2,
            emojiName: "🔥",
            me: true,
          },
        ],
      }),
    });
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
      botUserId: "bot",
      logger: createLogger(),
      message,
    });

    expect(generateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessage: expect.objectContaining({
          reactions: [
            {
              count: 1,
              emoji: "🎉",
            },
            {
              count: 3,
              emoji: "👍",
              selfReacted: true,
            },
          ],
          replyTo: expect.objectContaining({
            reactions: [
              {
                count: 2,
                emoji: "🔥",
                selfReacted: true,
              },
            ],
          }),
        }),
      }),
    );
  });

  it("リアクションがない場合は reactions フィールドを含めない", async () => {
    const message = createMessage({
      reactions: [],
    });
    const generateReply = vi.fn<ReplyGenerator["generateReply"]>(async () => undefined);
    const aiService = createAiService(generateReply);

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      allowDm: false,
      botUserId: "bot",
      logger: createLogger(),
      message,
    });

    expect(generateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessage: expect.not.objectContaining({
          reactions: expect.anything(),
        }),
      }),
    );
  });
});

function createMessage(input?: {
  attachments?: AttachmentLike[];
  authorId?: string;
  authorIsBot?: boolean;
  authorUsername?: string;
  channelId?: string;
  channelName?: string | null;
  content?: string;
  fetchHistory?: (options: {
    before?: string;
    limit: number;
  }) => Promise<Collection<string, HistoryMessageLike>>;
  fetchReference?: () => Promise<HistoryMessageLike>;
  inGuild?: boolean;
  isThread?: boolean;
  mentionBot?: boolean;
  reactions?: ReactionLike[];
  referenceMessage?: HistoryMessageLike;
  referenceMessageId?: string;
  reply?: MessageLike["reply"];
  sendTyping?: () => Promise<unknown>;
  stickers?: StickerLike[];
}): MessageLike {
  const reference = resolveReference(input?.referenceMessageId, input?.referenceMessage);
  const fallbackReferenceMessage = input?.referenceMessage;
  const fetchReference =
    input?.fetchReference ??
    (fallbackReferenceMessage
      ? async () => {
          return fallbackReferenceMessage;
        }
      : undefined);
  const fetchHistory =
    input?.fetchHistory ??
    vi.fn(async () => {
      return new Collection<string, HistoryMessageLike>();
    });
  const channel: MessageLike["channel"] = {
    isThread: () => input?.isThread ?? false,
    messages: {
      fetch: async (options: unknown) => {
        if (!isFetchHistoryOptions(options)) {
          throw new Error("invalid fetch options");
        }
        return fetchHistory(options);
      },
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
    content: input?.content ?? "hello?",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    createdTimestamp: new Date("2026-01-01T00:00:00.000Z").getTime(),
    id: "message",
    inGuild: () => input?.inGuild ?? true,
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
    stickers: createStickerCollection(input?.stickers ?? []),
    reference,
    fetchReference,
    reactions: createReactionManager(input?.reactions ?? []),
  };
}

function createFakeHistoryMessage(input: {
  authorDisplayName?: string;
  authorId?: string;
  authorIsBot?: boolean;
  authorUsername?: string;
  content?: string;
  id: string;
  createdAt: Date;
  referenceMessage?: HistoryMessageLike;
  referenceMessageId?: string;
  fetchReference?: () => Promise<HistoryMessageLike>;
  reactions?: ReactionLike[];
  stickers?: StickerLike[];
}): HistoryMessageLike {
  const reference = resolveReference(input.referenceMessageId, input.referenceMessage);
  const fallbackReferenceMessage = input.referenceMessage;
  const fetchReference =
    input.fetchReference ??
    (fallbackReferenceMessage
      ? async () => {
          return fallbackReferenceMessage;
        }
      : undefined);

  return {
    author: {
      bot: input.authorIsBot ?? false,
      id: input.authorId ?? "author",
      username: input.authorUsername ?? "author",
    },
    channelId: "channel",
    content: input.content ?? "history",
    createdAt: input.createdAt,
    createdTimestamp: input.createdAt.getTime(),
    id: input.id,
    member: {
      displayName: input.authorDisplayName ?? "display",
    },
    mentions: {
      has: () => false,
    },
    attachments: createAttachmentCollection([]),
    reactions: createReactionManager(input.reactions ?? []),
    stickers: createStickerCollection(input.stickers ?? []),
    reference,
    fetchReference,
  };
}

function resolveReference(
  referenceMessageId: string | undefined,
  referenceMessage: HistoryMessageLike | undefined,
): { messageId: string } | undefined {
  if (referenceMessageId) {
    return { messageId: referenceMessageId };
  }
  if (referenceMessage) {
    return { messageId: referenceMessage.id };
  }
  return undefined;
}

function isFetchHistoryOptions(value: unknown): value is {
  before?: string;
  limit: number;
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("limit" in value) || typeof value.limit !== "number") {
    return false;
  }

  if (!("before" in value) || value.before === undefined) {
    return true;
  }

  return typeof value.before === "string";
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

function createStickerCollection(stickers: StickerLike[]): Collection<string, StickerLike> {
  return new Collection<string, StickerLike>(
    stickers.map((sticker) => {
      return [sticker.id, sticker];
    }),
  );
}

function createReactionManager(reactions: ReactionLike[]) {
  return {
    cache: new Collection(
      reactions.map((reaction, index) => {
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
  };
}

function createAiService(generateReply: ReplyGenerator["generateReply"]): ReplyGenerator {
  return {
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
