import { describe, expect, it, vi } from "vitest";

import type { AiService } from "../ai/ai-service";
import type { ConversationContext, RuntimeMessage } from "../context/types";

import { handleMessageCreate, type MessageLike } from "./message-handler";

describe("handleMessageCreate integration", () => {
  it("指定チャンネルの通常投稿で tool use により履歴取得と返信が行われる", async () => {
    const reply = vi.fn(async () => undefined);
    const message = createMessage({ reply });
    const fetchConversationContext = vi.fn(async () => {
      return createContext([createRuntimeMessage("1")]);
    });
    const aiService: AiService = {
      generateReply: vi.fn(async (input) => {
        const context = await input.tools.fetchDiscordHistory({
          limit: input.contextFetchLimit,
        });
        expect(context.recentMessages).toHaveLength(1);
        await input.tools.sendDiscordReply({ text: "hello" });

        return {
          didReply: true,
        };
      }),
    };

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      apologyMessage: "apology",
      botUserId: "bot",
      contextFetchLimit: 20,
      fetchConversationContext,
      logger: createLogger(),
      message,
    });

    expect(fetchConversationContext).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith("hello");
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
      fetchConversationContext: async () => {
        return createContext([createRuntimeMessage("1")]);
      },
      logger: createLogger(),
      message,
    });

    expect(reply).toHaveBeenCalledWith("ごめんね");
  });

  it("指定外チャンネルは無反応", async () => {
    const reply = vi.fn(async () => undefined);
    const fetchConversationContext = vi.fn(async () => {
      return createContext([createRuntimeMessage("1")]);
    });
    const message = createMessage({ channelId: "other", reply });
    const aiService: AiService = {
      generateReply: vi.fn(async () => {
        return {
          didReply: false,
        };
      }),
    };

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      apologyMessage: "apology",
      botUserId: "bot",
      contextFetchLimit: 20,
      fetchConversationContext,
      logger: createLogger(),
      message,
    });

    expect(fetchConversationContext).not.toHaveBeenCalled();
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
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createContext(recentMessages: RuntimeMessage[]): ConversationContext {
  return {
    channelId: "allowed",
    recentMessages,
    requestedByToolUse: false,
  };
}

function createRuntimeMessage(id: string): RuntimeMessage {
  return {
    id,
    channelId: "allowed",
    authorId: "author",
    authorName: "author",
    content: "hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    mentionedBot: false,
  };
}
