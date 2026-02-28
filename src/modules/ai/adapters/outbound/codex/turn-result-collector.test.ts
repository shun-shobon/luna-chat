import { describe, expect, it, vi } from "vitest";

import {
  bindTrackerToTurn,
  createTurnTracker,
  handleTurnNotification,
  waitForTurnCompletion,
} from "./turn-result-collector";

describe("turn-result-collector", () => {
  it("thread/tokenUsage/updated の値を turn 完了結果へ反映する", async () => {
    const tracker = createTurnTracker({ threadId: "thread-1" });
    bindTrackerToTurn(tracker, "turn-1");

    handleTurnNotification(
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          tokenUsage: {
            last: {
              cachedInputTokens: 5,
              inputTokens: 30,
              outputTokens: 40,
              reasoningOutputTokens: 10,
              totalTokens: 70,
            },
            modelContextWindow: 200_000,
            total: {
              cachedInputTokens: 20,
              inputTokens: 100,
              outputTokens: 80,
              reasoningOutputTokens: 25,
              totalTokens: 180,
            },
          },
          turnId: "turn-1",
        },
      },
      tracker,
    );

    handleTurnNotification(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      },
      tracker,
    );

    const turnResult = await waitForTurnCompletion({
      onTimeout: async () => undefined,
      timeoutMs: 100,
      tracker,
    });

    expect(turnResult.tokenUsage).toEqual({
      last: {
        cachedInputTokens: 5,
        inputTokens: 30,
        outputTokens: 40,
        reasoningOutputTokens: 10,
        totalTokens: 70,
      },
      modelContextWindow: 200_000,
      total: {
        cachedInputTokens: 20,
        inputTokens: 100,
        outputTokens: 80,
        reasoningOutputTokens: 25,
        totalTokens: 180,
      },
    });
  });

  it("MCP tool call の開始と終了を observer へ通知する", () => {
    const tracker = createTurnTracker({ threadId: "thread-1" });
    bindTrackerToTurn(tracker, "turn-1");

    const onMcpToolCallStarted = vi.fn();
    const onMcpToolCallCompleted = vi.fn();

    handleTurnNotification(
      {
        method: "item/started",
        params: {
          item: {
            server: "discord",
            status: "inProgress",
            tool: "read_message_history",
            type: "mcpToolCall",
          },
          threadId: "thread-1",
          turnId: "turn-1",
        },
      },
      tracker,
      {
        onMcpToolCallCompleted,
        onMcpToolCallStarted,
      },
    );

    handleTurnNotification(
      {
        method: "item/completed",
        params: {
          item: {
            arguments: { limit: 30 },
            result: { content: [] },
            server: "discord",
            status: "completed",
            tool: "read_message_history",
            type: "mcpToolCall",
          },
          threadId: "thread-1",
          turnId: "turn-1",
        },
      },
      tracker,
      {
        onMcpToolCallCompleted,
        onMcpToolCallStarted,
      },
    );

    expect(onMcpToolCallStarted).toHaveBeenCalledTimes(1);
    expect(onMcpToolCallStarted).toHaveBeenCalledWith({
      server: "discord",
      threadId: "thread-1",
      tool: "read_message_history",
      turnId: "turn-1",
    });

    expect(onMcpToolCallCompleted).toHaveBeenCalledTimes(1);
    expect(onMcpToolCallCompleted).toHaveBeenCalledWith({
      server: "discord",
      status: "completed",
      threadId: "thread-1",
      tool: "read_message_history",
      turnId: "turn-1",
    });
  });

  it("snake_case 形式の通知もパースできる", async () => {
    const tracker = createTurnTracker({ threadId: "thread-1" });
    bindTrackerToTurn(tracker, "turn-1");

    handleTurnNotification(
      {
        method: "thread/tokenUsage/updated",
        params: {
          thread_id: "thread-1",
          token_usage: {
            last_token_usage: {
              cached_input_tokens: 0,
              input_tokens: 10,
              output_tokens: 3,
              reasoning_output_tokens: 1,
              total_tokens: 13,
            },
            model_context_window: null,
            total_token_usage: {
              cached_input_tokens: 2,
              input_tokens: 50,
              output_tokens: 15,
              reasoning_output_tokens: 5,
              total_tokens: 65,
            },
          },
          turn_id: "turn-1",
        },
      },
      tracker,
    );

    handleTurnNotification(
      {
        method: "item/completed",
        params: {
          item: {
            arguments: {},
            result: {},
            server: "discord",
            status: "in_progress",
            tool: "start_typing",
            type: "mcp_tool_call",
          },
          thread_id: "thread-1",
          turn_id: "turn-1",
        },
      },
      tracker,
    );

    handleTurnNotification(
      {
        method: "turn/completed",
        params: {
          thread_id: "thread-1",
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      },
      tracker,
    );

    const turnResult = await waitForTurnCompletion({
      onTimeout: async () => undefined,
      timeoutMs: 100,
      tracker,
    });

    expect(turnResult.mcpToolCalls).toEqual([
      {
        arguments: {},
        result: {},
        server: "discord",
        status: "inProgress",
        tool: "start_typing",
      },
    ]);

    expect(turnResult.tokenUsage).toEqual({
      last: {
        cachedInputTokens: 0,
        inputTokens: 10,
        outputTokens: 3,
        reasoningOutputTokens: 1,
        totalTokens: 13,
      },
      modelContextWindow: null,
      total: {
        cachedInputTokens: 2,
        inputTokens: 50,
        outputTokens: 15,
        reasoningOutputTokens: 5,
        totalTokens: 65,
      },
    });
  });

  it("別turnの通知は active turn と一致しなければ無視する", async () => {
    const tracker = createTurnTracker({ threadId: "thread-1" });
    bindTrackerToTurn(tracker, "turn-1");

    const onMcpToolCallStarted = vi.fn();

    handleTurnNotification(
      {
        method: "item/started",
        params: {
          item: {
            server: "discord",
            status: "inProgress",
            tool: "read_message_history",
            type: "mcpToolCall",
          },
          threadId: "thread-1",
          turnId: "turn-2",
        },
      },
      tracker,
      {
        onMcpToolCallStarted,
      },
    );

    handleTurnNotification(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-2",
            status: "completed",
          },
        },
      },
      tracker,
    );

    expect(onMcpToolCallStarted).not.toHaveBeenCalled();

    handleTurnNotification(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      },
      tracker,
    );

    const turnResult = await waitForTurnCompletion({
      onTimeout: async () => undefined,
      timeoutMs: 100,
      tracker,
    });

    expect(turnResult.status).toBe("completed");
  });
});
