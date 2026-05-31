import { describe, expect, it, vi } from "vitest";

import type { RuntimeMessage } from "../domain/runtime-message";

import { createDiscordAiDispatcher, resolveDiscordChannelScopeKey } from "./discord-ai-dispatcher";

type GenerateReplyForTest = (input: {
  currentMessages: [RuntimeMessage, ...RuntimeMessage[]];
}) => Promise<void>;

describe("createDiscordAiDispatcher", () => {
  it("設定された遅延が経過するまで AI を呼び出さない", async () => {
    vi.useFakeTimers();
    try {
      const generateReply = vi.fn<GenerateReplyForTest>(async () => undefined);
      const dispatcher = createDispatcher({ generateReply });

      dispatcher.enqueue(createDispatchInput({ id: "m1" }));

      await vi.advanceTimersByTimeAsync(4_999);
      expect(generateReply).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(generateReply).toHaveBeenCalledTimes(1);
      expect(generateReply).toHaveBeenCalledWith(
        expect.objectContaining({
          currentMessages: [expect.objectContaining({ id: "m1" })],
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("同一スコープの連投は待機時間をリセットして1回の AI 入力へまとめる", async () => {
    vi.useFakeTimers();
    try {
      const generateReply = vi.fn<GenerateReplyForTest>(async () => undefined);
      const dispatcher = createDispatcher({ generateReply });

      dispatcher.enqueue(createDispatchInput({ id: "m1" }));
      await vi.advanceTimersByTimeAsync(3_000);
      dispatcher.enqueue(createDispatchInput({ content: "second", id: "m2" }));

      await vi.advanceTimersByTimeAsync(4_999);
      expect(generateReply).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const replyInput = getFirstReplyInput(generateReply);
      expect(replyInput.currentMessages.map((message) => message.id)).toEqual(["m1", "m2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("別チャンネルは別スコープとして独立に送信する", async () => {
    vi.useFakeTimers();
    try {
      const generateReply = vi.fn<GenerateReplyForTest>(async () => undefined);
      const dispatcher = createDispatcher({ generateReply });

      dispatcher.enqueue(createDispatchInput({ channelId: "c1", id: "m1" }));
      dispatcher.enqueue(createDispatchInput({ channelId: "c2", id: "m2" }));

      await vi.advanceTimersByTimeAsync(5_000);

      expect(generateReply).toHaveBeenCalledTimes(2);
      expect(generateReply.mock.calls.map((call) => call[0].currentMessages[0].id).sort()).toEqual([
        "m1",
        "m2",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("別DMユーザーは別スコープとして独立に送信する", async () => {
    vi.useFakeTimers();
    try {
      const generateReply = vi.fn<GenerateReplyForTest>(async () => undefined);
      const dispatcher = createDispatcher({ generateReply });

      dispatcher.enqueue(
        createDispatchInput({ authorId: "u1", context: { kind: "dm" }, id: "m1" }),
      );
      dispatcher.enqueue(
        createDispatchInput({ authorId: "u2", context: { kind: "dm" }, id: "m2" }),
      );

      await vi.advanceTimersByTimeAsync(5_000);

      expect(generateReply).toHaveBeenCalledTimes(2);
      expect(generateReply.mock.calls.map((call) => call[0].currentMessages[0].id).sort()).toEqual([
        "m1",
        "m2",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("typing中は遅延経過後も送信せず、typing timeout 後に送信する", async () => {
    vi.useFakeTimers();
    try {
      const generateReply = vi.fn<GenerateReplyForTest>(async () => undefined);
      const dispatcher = createDispatcher({ generateReply });

      dispatcher.recordTypingStart({
        scopeKey: resolveDiscordChannelScopeKey("c1"),
        userId: "u2",
      });
      dispatcher.enqueue(createDispatchInput({ channelId: "c1", id: "m1" }));

      await vi.advanceTimersByTimeAsync(9_999);
      expect(generateReply).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(generateReply).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("typing中ユーザーがメッセージ送信したら typing 終了扱いにし、待機時間をリセットする", async () => {
    vi.useFakeTimers();
    try {
      const generateReply = vi.fn<GenerateReplyForTest>(async () => undefined);
      const dispatcher = createDispatcher({ generateReply });

      dispatcher.recordTypingStart({
        scopeKey: resolveDiscordChannelScopeKey("c1"),
        userId: "u2",
      });
      dispatcher.enqueue(createDispatchInput({ authorId: "u1", channelId: "c1", id: "m1" }));
      await vi.advanceTimersByTimeAsync(4_000);
      dispatcher.enqueue(createDispatchInput({ authorId: "u2", channelId: "c1", id: "m2" }));

      await vi.advanceTimersByTimeAsync(4_999);
      expect(generateReply).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const replyInput = getFirstReplyInput(generateReply);
      expect(replyInput.currentMessages.map((message) => message.id)).toEqual(["m1", "m2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("バッチ内にBotメンションがあれば AI 送信中だけ入力中表示を開始する", async () => {
    vi.useFakeTimers();
    try {
      const sendTyping = vi.fn(async () => undefined);
      const typingRegistry = createTypingRegistryStub();
      const generateReply = vi.fn<GenerateReplyForTest>(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000);
        });
      });
      const dispatcher = createDispatcher({ generateReply, typingRegistry });

      dispatcher.enqueue(
        createDispatchInput({
          id: "m1",
          mentionedBot: true,
          sendTyping,
        }),
      );

      await vi.advanceTimersByTimeAsync(5_000);
      expect(typingRegistry.start).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(typingRegistry.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("AI 呼び出し失敗時はログに記録し、メンション起点 typing を停止する", async () => {
    vi.useFakeTimers();
    try {
      const typingRegistry = createTypingRegistryStub();
      const logger = createLogger();
      const generateReply = vi.fn<GenerateReplyForTest>(async () => {
        throw new Error("ai failed");
      });
      const dispatcher = createDispatcher({ generateReply, logger, typingRegistry });

      dispatcher.enqueue(
        createDispatchInput({
          id: "m1",
          mentionedBot: true,
          sendTyping: vi.fn(async () => undefined),
        }),
      );

      await vi.advanceTimersByTimeAsync(5_000);

      expect(logger.error).toHaveBeenCalledWith("Failed to generate AI reply:", expect.any(Error));
      expect(typingRegistry.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

type CreateDispatcherInput = {
  generateReply: GenerateReplyForTest;
  logger?: ReturnType<typeof createLogger>;
  typingRegistry?: ReturnType<typeof createTypingRegistryStub>;
};

function createDispatcher(input: CreateDispatcherInput) {
  return createDiscordAiDispatcher({
    aiService: {
      generateReply: async (replyInput) => {
        await input.generateReply(replyInput);
      },
    },
    dispatchDelayMs: 5_000,
    logger: input.logger ?? createLogger(),
    typingIdleTimeoutMs: 10_000,
    typingLifecycleRegistry: input.typingRegistry ?? createTypingRegistryStub(),
  });
}

function getFirstReplyInput(generateReply: ReturnType<typeof vi.fn<GenerateReplyForTest>>) {
  const replyInput = generateReply.mock.calls[0]?.[0];
  if (!replyInput) {
    throw new Error("generateReply was not called.");
  }

  return replyInput;
}

function createDispatchInput(input: {
  authorId?: string;
  channelId?: string;
  content?: string;
  context?: { kind: "dm" } | { kind: "channel"; channelName: string };
  id: string;
  mentionedBot?: boolean;
  sendTyping?: () => Promise<unknown>;
}) {
  const currentMessage: RuntimeMessage = {
    attachments: [],
    authorId: input.authorId ?? "u1",
    authorIsBot: false,
    authorName: input.authorId ?? "u1",
    channelId: input.channelId ?? "c1",
    content: input.content ?? "hello",
    createdAt: "2026-01-01 09:00:00 JST",
    id: input.id,
    mentionedBot: input.mentionedBot ?? false,
  };

  return {
    context: input.context ?? {
      kind: "channel",
      channelName: "general",
    },
    currentMessage,
    loadRecentMessages: async () => [],
    sendTyping: input.sendTyping,
  };
}

function createTypingRegistryStub() {
  const stop = vi.fn();
  return {
    start: vi.fn(() => {
      return {
        alreadyRunning: false,
        ok: true as const,
        stop,
      };
    }),
    stop,
    stopAll: vi.fn(),
    stopByChannelId: vi.fn(),
  };
}

function createLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  };
}
