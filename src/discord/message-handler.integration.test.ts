import { describe, expect, it, vi } from "vitest";

import type { AiService } from "../ai/ai-service";

import { handleMessageCreate, type MessageLike } from "./message-handler";

describe("handleMessageCreate integration", () => {
  it("指定チャンネルの通常投稿で AI が呼び出される", async () => {
    const reply = vi.fn(async () => undefined);
    const message = createMessage({ reply });
    const generateReply = vi.fn(async () => {
      return {
        didReply: true,
      };
    });
    const aiService: AiService = {
      generateReply,
    };

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      apologyMessage: "apology",
      botUserId: "bot",
      contextFetchLimit: 20,
      logger: createLogger(),
      message,
    });

    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it("メンション投稿で AI が失敗したら謝罪テンプレートを返す", async () => {
    const reply = vi.fn(async () => undefined);
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
      apologyMessage: "ごめんね",
      botUserId: "bot",
      contextFetchLimit: 20,
      logger: createLogger(),
      message,
    });

    expect(reply).toHaveBeenCalledWith("ごめんね");
  });

  it("指定外チャンネルは無反応", async () => {
    const reply = vi.fn(async () => undefined);
    const message = createMessage({ channelId: "other", reply });
    const generateReply = vi.fn(async () => {
      return {
        didReply: false,
      };
    });
    const aiService: AiService = {
      generateReply,
    };

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      apologyMessage: "apology",
      botUserId: "bot",
      contextFetchLimit: 20,
      logger: createLogger(),
      message,
    });

    expect(generateReply).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});

function createMessage(input?: {
  channelId?: string;
  mentionBot?: boolean;
  reply?: MessageLike["reply"];
}): MessageLike {
  return {
    author: {
      bot: false,
      id: "author",
      username: "author",
    },
    channel: {
      isThread: () => false,
    },
    channelId: input?.channelId ?? "allowed",
    content: "hello?",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
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

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}
