import { describe, expect, it, vi } from "vitest";

import type { ConversationContext, RuntimeMessage } from "../context/types";

import type { AiInput, AiOutput, AiService } from "./ai-service";
import { resolveAiReplyWithHistoryLoop } from "./reply-orchestrator";

describe("resolveAiReplyWithHistoryLoop", () => {
  it("追加履歴要求がなければ最初の応答を返す", async () => {
    const aiService: AiService = {
      generateReply: vi.fn(async () => {
        return {
          needsMoreHistory: false,
          replyText: "ok",
          shouldReply: true,
        };
      }),
    };

    const reply = await resolveAiReplyWithHistoryLoop({
      aiService,
      currentMessage: createRuntimeMessage("3"),
      fetchMoreHistory: async () => {
        throw new Error("must not be called");
      },
      forceReply: false,
      initialContext: createContext([createRuntimeMessage("1"), createRuntimeMessage("2")]),
      logger: { info: vi.fn() },
      operationRulesDoc: "rules",
    });

    expect(reply).toEqual({
      needsMoreHistory: false,
      replyText: "ok",
      shouldReply: true,
    });
  });

  it("追加履歴要求がある場合は履歴を取得して再試行する", async () => {
    const outputs: AiOutput[] = [
      {
        needsMoreHistory: true,
        replyText: "",
        shouldReply: false,
      },
      {
        needsMoreHistory: false,
        replyText: "final",
        shouldReply: true,
      },
    ];
    const seenInputs: AiInput[] = [];
    const aiService: AiService = {
      generateReply: vi.fn(async (input) => {
        seenInputs.push(input);
        return outputs.shift() ?? outputs[outputs.length - 1]!;
      }),
    };
    const logger = { info: vi.fn() };

    const reply = await resolveAiReplyWithHistoryLoop({
      aiService,
      currentMessage: createRuntimeMessage("3"),
      fetchMoreHistory: async () => {
        return createContext([createRuntimeMessage("0")], true);
      },
      forceReply: false,
      initialContext: createContext([createRuntimeMessage("1"), createRuntimeMessage("2")]),
      logger,
      operationRulesDoc: "rules",
    });

    expect(reply.replyText).toBe("final");
    expect(seenInputs).toHaveLength(2);
    expect(seenInputs[1]?.context.recentMessages.map((message) => message.id)).toEqual([
      "0",
      "1",
      "2",
    ]);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});

function createContext(
  recentMessages: RuntimeMessage[],
  requestedByToolUse = false,
): ConversationContext {
  return {
    channelId: "channel",
    recentMessages,
    requestedByToolUse,
  };
}

function createRuntimeMessage(id: string): RuntimeMessage {
  return {
    id,
    channelId: "channel",
    authorId: "author",
    authorName: "author",
    content: `message-${id}`,
    createdAt: `2026-01-01T00:00:0${id}.000Z`,
    mentionedBot: false,
  };
}
