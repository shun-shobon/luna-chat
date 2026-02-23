import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiService } from "../ai/ai-service";
import type { ConversationContext, RuntimeMessage } from "../context/types";

import { handleMessageCreate, type MessageLike } from "./message-handler";

describe("handleMessageCreate integration", () => {
  let workspaceDir = "";

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "luna-message-handler-"));
    mkdirSync(join(workspaceDir, "persona"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { force: true, recursive: true });
  });

  it("指定チャンネルの通常投稿で AI が shouldReply=true なら返信する", async () => {
    const reply = vi.fn(async () => undefined);
    const message = createMessage({ reply });
    const aiService = createAiService({
      needsMoreHistory: false,
      replyText: "hello",
      shouldReply: true,
    });
    const fetchConversationContext = vi.fn(async () => {
      return createContext([createRuntimeMessage("1")]);
    });

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      apologyMessage: "apology",
      botUserId: "bot",
      codexWorkspaceDir: workspaceDir,
      contextFetchLimit: 20,
      fetchConversationContext,
      logger: createLogger(),
      message,
      operationRulesDoc: "rules",
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
      codexWorkspaceDir: workspaceDir,
      contextFetchLimit: 20,
      fetchConversationContext: async () => {
        return createContext([createRuntimeMessage("1")]);
      },
      logger: createLogger(),
      message,
      operationRulesDoc: "rules",
    });

    expect(reply).toHaveBeenCalledWith("ごめんね");
  });

  it("指定外チャンネルは無反応", async () => {
    const reply = vi.fn(async () => undefined);
    const fetchConversationContext = vi.fn(async () => {
      return createContext([createRuntimeMessage("1")]);
    });
    const message = createMessage({ channelId: "other", reply });
    const aiService = createAiService({
      needsMoreHistory: false,
      replyText: "hello",
      shouldReply: true,
    });

    await handleMessageCreate({
      aiService,
      allowedChannelIds: new Set(["allowed"]),
      apologyMessage: "apology",
      botUserId: "bot",
      codexWorkspaceDir: workspaceDir,
      contextFetchLimit: 20,
      fetchConversationContext,
      logger: createLogger(),
      message,
      operationRulesDoc: "rules",
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

function createAiService(output: {
  shouldReply: boolean;
  replyText: string;
  needsMoreHistory: boolean;
}): AiService {
  return {
    generateReply: vi.fn(async () => output),
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
