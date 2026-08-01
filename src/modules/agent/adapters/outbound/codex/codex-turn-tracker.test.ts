import { describe, expect, it } from "vitest";

import { CodexTurnTracker, TurnCorrelationError } from "./codex-turn-tracker";

describe("CodexTurnTracker", () => {
  it("final_answer を AgentOutput として検証して完了する", async () => {
    const tracker = new CodexTurnTracker("thread-1");
    tracker.bindTurnId("turn-1");
    tracker.handleNotification({
      method: "item/completed",
      params: {
        completedAtMs: 1,
        item: {
          phase: "final_answer",
          text: '{"actions":[{"kind":"start_typing","target":{"kind":"channel","channelId":"123"}}]}',
          type: "agentMessage",
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    tracker.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { error: null, id: "turn-1", status: "completed" },
      },
    });

    await expect(tracker.completion).resolves.toMatchObject({ status: "completed" });
  });

  it("同一 thread の異なる turn id を拒否する", () => {
    const tracker = new CodexTurnTracker("thread-1");
    tracker.bindTurnId("turn-1");

    expect(() =>
      tracker.handleNotification({
        method: "item/completed",
        params: {
          completedAtMs: 1,
          item: { type: "plan" },
          threadId: "thread-1",
          turnId: "turn-2",
        },
      }),
    ).toThrow(TurnCorrelationError);
  });

  it("turn 固有 delta の相関 ID 欠落を拒否する", () => {
    const tracker = new CodexTurnTracker("thread-1");
    tracker.bindTurnId("turn-1");

    expect(() =>
      tracker.handleNotification({
        method: "item/reasoning/textDelta",
        params: { threadId: "thread-1" },
      }),
    ).toThrow();
  });

  it("final_answer が schema 違反なら turn failure にする", async () => {
    const tracker = new CodexTurnTracker("thread-1");
    tracker.bindTurnId("turn-1");
    tracker.handleNotification({
      method: "item/completed",
      params: {
        item: { phase: "final_answer", text: '{"actions":"invalid"}', type: "agentMessage" },
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    tracker.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { error: null, id: "turn-1", status: "completed" },
      },
    });

    await expect(tracker.completion).resolves.toMatchObject({ status: "failed" });
  });

  it("request_user_input を当該 turn の failure にする", async () => {
    const tracker = new CodexTurnTracker("thread-1");
    tracker.bindTurnId("turn-1");

    expect(
      tracker.handleServerRequest({
        id: 7,
        method: "item/tool/requestUserInput",
        params: { threadId: "thread-1", turnId: "turn-1" },
      }),
    ).toBe(true);
    tracker.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { error: null, id: "turn-1", status: "failed" },
      },
    });
    await expect(tracker.completion).resolves.toMatchObject({ status: "failed" });
  });
});
