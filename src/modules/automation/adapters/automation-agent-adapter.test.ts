import { describe, expect, it, vi } from "vitest";

import type {
  AgentRuntimePort,
  AgentTurnResult,
} from "../../agent/ports/outbound/agent-runtime-port";
import type { DiscordActionBatchPort } from "../../discord/ports/discord-action-batch-port";

import { AutomationAgentAdapter } from "./automation-agent-adapter";

describe("AutomationAgentAdapter", () => {
  it("turn/start responseを返し、action failureを同じthreadでfollow-upする", async () => {
    const completions: AgentTurnResult[] = [
      {
        status: "completed",
        output: {
          actions: [
            { kind: "send_message", target: { kind: "channel", channelId: "100" }, content: "hi" },
          ],
        },
      },
      { status: "completed", output: { actions: [] } },
    ];
    const { agent, startTurn } = createAgent(completions);
    const execute = vi
      .fn<DiscordActionBatchPort["execute"]>(async () => [])
      .mockResolvedValueOnce([
        {
          actionKind: "send_message",
          index: 0,
          success: false,
          target: { kind: "channel", channelId: "100" },
          error: "failed",
        },
      ]);
    const releaseTyping = vi.fn(async () => undefined);
    const actions: DiscordActionBatchPort = {
      execute,
      releaseTyping,
    };
    const adapter = new AutomationAgentAdapter(agent, actions, async () => threadInput, vi.fn());

    const threadId = await adapter.openAutomationThread();
    const turn = await adapter.startAutomationTurn(threadId, {
      source: "schedule",
      jobId: "daily",
      prompt: "run",
    });
    await turn.completion;

    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(startTurn).toHaveBeenNthCalledWith(
      1,
      "thread-1",
      JSON.stringify({ source: "schedule", jobId: "daily", prompt: "run" }),
    );
    expect(JSON.parse(startTurn.mock.calls[1]?.[1] ?? "null")).toMatchObject({
      source: "discord_action_results",
      results: [{ actionKind: "send_message", success: false, error: "failed" }],
    });
    expect(releaseTyping).toHaveBeenCalledTimes(2);
  });

  it("archive時にowner参照を破棄する", async () => {
    const { agent } = createAgent([{ status: "completed", output: { actions: [] } }]);
    const actions: DiscordActionBatchPort = {
      execute: vi.fn(async () => []),
      releaseTyping: vi.fn(async () => undefined),
    };
    const adapter = new AutomationAgentAdapter(agent, actions, async () => threadInput, vi.fn());
    const threadId = await adapter.openAutomationThread();

    await adapter.archiveThread(threadId);

    await expect(
      adapter.startAutomationTurn(threadId, { source: "heartbeat", checklist: "check" }),
    ).rejects.toThrow("not owned");
  });

  it("typing解放失敗を記録し、正常なaction chainを完了する", async () => {
    const { agent } = createAgent([{ status: "completed", output: { actions: [] } }]);
    const failure = new Error("release failed");
    const onError = vi.fn();
    const actions: DiscordActionBatchPort = {
      execute: vi.fn(async () => []),
      releaseTyping: vi.fn(async () => {
        throw failure;
      }),
    };
    const adapter = new AutomationAgentAdapter(agent, actions, async () => threadInput, onError);
    const threadId = await adapter.openAutomationThread();

    const turn = await adapter.startAutomationTurn(threadId, {
      source: "heartbeat",
      checklist: "check",
    });

    await expect(turn.completion).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(failure, "typing/release");
  });

  it("action実行中のconnection loss後は旧threadへfollow-upしない", async () => {
    const { agent, startTurn } = createAgent([{ status: "completed", output: { actions: [] } }]);
    const execution = deferred<
      readonly [
        {
          actionKind: "send_message";
          index: number;
          success: false;
          target: { kind: "channel"; channelId: string };
          error: string;
        },
      ]
    >();
    const actions: DiscordActionBatchPort = {
      execute: vi.fn(async () => await execution.promise),
      releaseTyping: vi.fn(async () => undefined),
    };
    const adapter = new AutomationAgentAdapter(agent, actions, async () => threadInput, vi.fn());
    const threadId = await adapter.openAutomationThread();
    const turn = await adapter.startAutomationTurn(threadId, {
      source: "heartbeat",
      checklist: "check",
    });
    await Promise.resolve();

    adapter.connectionLost();
    execution.resolve([
      {
        actionKind: "send_message",
        index: 0,
        success: false,
        target: { kind: "channel", channelId: "100" },
        error: "failed",
      },
    ]);

    await expect(turn.completion).rejects.toThrow("connection was lost");
    expect(startTurn).toHaveBeenCalledOnce();
  });
});

const threadInput = {
  actionOwnerId: "owner-1",
  baseInstructions: "Luna",
  config: {},
  cwd: "/workspace",
  developerInstructions: "protocol",
};

function createAgent(completions: AgentTurnResult[]) {
  let index = 0;
  const startTurn = vi.fn<AgentRuntimePort["startTurn"]>(async () => {
    const completion: AgentTurnResult = completions[index] ?? {
      status: "completed",
      output: { actions: [] },
    };
    index += 1;
    return { turnId: `turn-${index}`, completion: Promise.resolve(completion) };
  });
  const agent: AgentRuntimePort = {
    archiveThread: vi.fn(async () => undefined),
    deleteThread: vi.fn(async () => undefined),
    listThreads: vi.fn(async () => ({ data: [] })),
    openThread: vi.fn(async () => "thread-1"),
    interruptTurn: vi.fn(async () => undefined),
    startTurn,
    steerTurn: vi.fn(async () => undefined),
  };
  return { agent, startTurn };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("deferred is not initialized");
      resolvePromise(value);
    },
  };
}
