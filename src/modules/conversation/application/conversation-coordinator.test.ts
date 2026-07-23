import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentRuntimePort,
  AgentTurnResult,
  StartedAgentTurn,
} from "../../agent/ports/outbound/agent-runtime-port";
import type { ConversationScope } from "../../discord/domain/conversation-scope";
import type { DiscordMessage } from "../../discord/domain/discord-message";
import type {
  DiscordActionBatchPort,
  DiscordActionResult,
} from "../../discord/ports/discord-action-batch-port";
import type { ConversationHistoryPort } from "../ports/conversation-history-port";

import { ConversationCoordinator } from "./conversation-coordinator";

afterEach(() => {
  vi.useRealTimers();
});

describe("ConversationCoordinator", () => {
  it("debounce後にhistoryとtimestamp順batchを新threadへ渡す", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    const historyMessage = message("90", "2026-07-23T00:00:00.000Z");
    const history: ConversationHistoryPort = {
      fetchBefore: vi.fn(async () => [historyMessage, message("101", "2026-07-23T00:00:02.000Z")]),
    };
    const coordinator = createCoordinator(runtime.port, { history });

    coordinator.accept({ scope, message: message("102", "2026-07-23T00:00:03.000Z") });
    coordinator.accept({ scope, message: message("101", "2026-07-23T00:00:02.000Z") });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();

    expect(runtime.startTurn).toHaveBeenCalledOnce();
    const input = parseStartInput(runtime.startTurn.mock.calls[0]?.[1]);
    expect(input.history.map((item) => item.id)).toEqual(["90"]);
    expect(input.messages.map((item) => item.id)).toEqual(["101", "102"]);
  });

  it("active turn中の投稿を受信順に一件ずつsteerする", async () => {
    vi.useFakeTimers();
    const firstCompletion = deferred<AgentTurnResult>();
    const runtime = createRuntime([firstCompletion.promise]);
    const coordinator = createCoordinator(runtime.port);

    coordinator.accept({ scope, message: message("100", "2026-07-23T00:00:00.000Z") });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    coordinator.accept({ scope, message: message("101", "2026-07-23T00:00:01.000Z") });
    coordinator.accept({ scope, message: message("102", "2026-07-23T00:00:02.000Z") });
    await flushPromises();

    expect(runtime.steerTurn).toHaveBeenCalledTimes(2);
    expect(runtime.steerTurn.mock.calls.map((call) => JSON.parse(call[2]).messages[0].id)).toEqual([
      "101",
      "102",
    ]);
    firstCompletion.resolve(completed([]));
  });

  it("最初のmessageより前に始まったhuman typingが途切れるまでbatchを待つ", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    const coordinator = createCoordinator(runtime.port);

    coordinator.typing(scope, "100");
    expect(coordinator.hasSession(scope)).toBe(false);
    coordinator.accept({ scope, message: message("100", "2026-07-23T00:00:00.000Z") });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(80);
    coordinator.typing(scope, "100");
    await flushPromises();
    await vi.advanceTimersByTimeAsync(20);
    await flushPromises();
    expect(runtime.startTurn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30);
    await flushPromises();
    expect(runtime.startTurn).toHaveBeenCalledOnce();
  });

  it("abort時にpending timerをすべて破棄する", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    const coordinator = createCoordinator(runtime.port);

    coordinator.typing(scope, "100");
    await flushPromises();
    expect(vi.getTimerCount()).toBe(1);

    await coordinator.abort();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("steerに失敗した投稿だけを次turnへ移す", async () => {
    vi.useFakeTimers();
    const firstCompletion = deferred<AgentTurnResult>();
    const runtime = createRuntime([firstCompletion.promise, Promise.resolve(completed([]))]);
    runtime.steerTurn.mockRejectedValueOnce(new Error("steer failed"));
    const coordinator = createCoordinator(runtime.port);

    coordinator.accept({ scope, message: message("100", "2026-07-23T00:00:00.000Z") });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    coordinator.accept({ scope, message: message("101", "2026-07-23T00:00:01.000Z") });
    await flushPromises();
    firstCompletion.resolve(completed([]));
    await flushPromises();

    expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    const nextInput = parseStartInput(runtime.startTurn.mock.calls[1]?.[1]);
    expect(nextInput.messages.map((item) => item.id)).toEqual(["101"]);
  });

  it("action失敗結果を同じthreadのfollow-up turnへ渡す", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime([
      Promise.resolve(
        completed([
          { kind: "send_message", target: { kind: "channel", channelId: "200" }, content: "hi" },
        ]),
      ),
      Promise.resolve(completed([])),
    ]);
    const execute = vi
      .fn<DiscordActionBatchPort["execute"]>(async () => [])
      .mockResolvedValueOnce([
        {
          actionKind: "send_message",
          index: 0,
          success: false,
          target: { kind: "channel", channelId: "200" },
          error: "Discord unavailable",
        },
      ]);
    const actions: DiscordActionBatchPort = {
      execute,
      releaseTyping: vi.fn(async () => undefined),
    };
    const coordinator = createCoordinator(runtime.port, { actions });

    coordinator.accept({ scope, message: message("100", "2026-07-23T00:00:00.000Z") });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();

    expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    const followUp = JSON.parse(runtime.startTurn.mock.calls[1]?.[1] ?? "null");
    expect(followUp).toMatchObject({
      source: "discord_action_results",
      results: [
        {
          actionKind: "send_message",
          index: 0,
          success: false,
          target: { kind: "channel", channelId: "200" },
          error: "Discord unavailable",
        },
      ],
    });
  });

  it("idle期限後にthreadをarchiveしてsessionを破棄する", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    const coordinator = createCoordinator(runtime.port);

    coordinator.accept({ scope, message: message("100", "2026-07-23T00:00:00.000Z") });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(runtime.archiveThread).toHaveBeenCalledWith("thread-1");
    expect(coordinator.hasSession(scope)).toBe(false);
  });

  it("shutdown時はactive chainを待ってからarchiveする", async () => {
    vi.useFakeTimers();
    const completion = deferred<AgentTurnResult>();
    const runtime = createRuntime([completion.promise]);
    const coordinator = createCoordinator(runtime.port);

    coordinator.accept({ scope, message: message("100", "2026-07-23T00:00:00.000Z") });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    const draining = coordinator.drain();
    await flushPromises();
    expect(runtime.archiveThread).not.toHaveBeenCalled();

    completion.resolve(completed([]));
    await draining;

    expect(runtime.archiveThread).toHaveBeenCalledWith("thread-1");
    expect(coordinator.hasSession(scope)).toBe(false);
  });

  it("turn失敗を記録し、typingを解放してからarchiveする", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime([
      Promise.resolve({ status: "failed", errorMessage: "model failed" }),
    ]);
    const releaseTyping = vi.fn(async () => undefined);
    const actions: DiscordActionBatchPort = {
      execute: vi.fn(async () => []),
      releaseTyping,
    };
    const onError = vi.fn();
    const coordinator = createCoordinator(runtime.port, { actions, onError });

    coordinator.accept({ scope, message: message("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();

    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      scope,
      operation: "turn/completion",
    });
    expect(releaseTyping).toHaveBeenCalledWith("owner-1");
    expect(runtime.archiveThread).toHaveBeenCalledWith("thread-1");
  });

  it("opening中のconnection lossでは未開始batchを一度だけ新runtimeへ渡す", async () => {
    vi.useFakeTimers();
    const firstHistory = deferred<readonly DiscordMessage[]>();
    const history: ConversationHistoryPort = {
      fetchBefore: vi
        .fn<ConversationHistoryPort["fetchBefore"]>()
        .mockImplementationOnce(async () => await firstHistory.promise)
        .mockResolvedValueOnce([]),
    };
    const runtime = createRuntime();
    const coordinator = createCoordinator(runtime.port, { history });

    coordinator.accept({ scope, message: message("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    coordinator.connectionLost(new Error("connection lost"));
    await flushPromises();
    firstHistory.resolve([]);
    await flushPromises();

    expect(runtime.openThread).toHaveBeenCalledOnce();
    expect(runtime.startTurn).toHaveBeenCalledOnce();
    expect(parseStartInput(runtime.startTurn.mock.calls[0]?.[1]).messages).toHaveLength(1);
  });

  it("orphaned actionsをsettle後、受理済みqueueを新threadで処理する", async () => {
    vi.useFakeTimers();
    const execution = deferred<readonly DiscordActionResult[]>();
    const actions: DiscordActionBatchPort = {
      execute: vi.fn(async () => await execution.promise),
      releaseTyping: vi.fn(async () => undefined),
    };
    const runtime = createRuntime([
      Promise.resolve(
        completed([
          { kind: "send_message", target: { kind: "channel", channelId: "200" }, content: "hi" },
        ]),
      ),
      Promise.resolve(completed([])),
    ]);
    const coordinator = createCoordinator(runtime.port, { actions });

    coordinator.accept({ scope, message: message("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    coordinator.connectionLost(new Error("connection lost"));
    coordinator.accept({ scope, message: message("101", "2026-07-23T00:00:01.000Z") });
    await flushPromises();
    execution.resolve([
      {
        actionKind: "send_message",
        index: 0,
        success: true,
        target: { kind: "channel", channelId: "200" },
        value: { actionKind: "send_message" },
      },
    ]);
    await flushPromises();

    expect(runtime.openThread).toHaveBeenCalledTimes(2);
    expect(runtime.startTurn).toHaveBeenCalledTimes(2);
  });

  it("archiving中の受理投稿をarchive完了後の新threadへ渡す", async () => {
    vi.useFakeTimers();
    const archived = deferred<void>();
    const runtime = createRuntime([Promise.resolve(completed([])), Promise.resolve(completed([]))]);
    runtime.archiveThread.mockImplementationOnce(async () => await archived.promise);
    const coordinator = createCoordinator(runtime.port);

    coordinator.accept({ scope, message: message("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    coordinator.accept({ scope, message: message("101", "2026-07-23T00:00:01.000Z") });
    archived.resolve();
    await flushPromises();

    expect(runtime.openThread).toHaveBeenCalledTimes(2);
    expect(runtime.startTurn).toHaveBeenCalledTimes(2);
  });
});

const scope = { kind: "guild_channel", guildId: "300", channelId: "200" } as const;

function createCoordinator(
  agent: AgentRuntimePort,
  overrides: {
    actions?: DiscordActionBatchPort;
    history?: ConversationHistoryPort;
    onError?: (error: unknown, context: { scope: ConversationScope; operation: string }) => void;
  } = {},
): ConversationCoordinator {
  return new ConversationCoordinator(
    {
      agent,
      actions: overrides.actions ?? {
        execute: vi.fn<DiscordActionBatchPort["execute"]>(async (actions) =>
          actions.map((action, index) => ({
            actionKind: action.kind,
            index,
            success: true as const,
            target:
              "target" in action
                ? action.target
                : {
                    kind: "message" as const,
                    channelId: action.channelId,
                    messageId: action.messageId,
                  },
            value: { actionKind: action.kind },
          })),
        ),
        releaseTyping: vi.fn(async () => undefined),
      },
      history: overrides.history ?? { fetchBefore: vi.fn(async () => []) },
      createThreadInput: vi.fn(async () => ({
        actionOwnerId: "owner-1",
        baseInstructions: "Luna",
        config: {},
        cwd: "/workspace",
        developerInstructions: "protocol",
      })),
      onError: overrides.onError ?? vi.fn(),
      onEvent: vi.fn(),
    },
    { debounceMs: 100, typingIdleMs: 50, sessionIdleMs: 1_000, initialHistoryLimit: 20 },
  );
}

function createRuntime(completions: Promise<AgentTurnResult>[] = [Promise.resolve(completed([]))]) {
  let turnIndex = 0;
  const startTurn = vi.fn<AgentRuntimePort["startTurn"]>(
    async (_threadId, _input): Promise<StartedAgentTurn> => ({
      turnId: `turn-${turnIndex + 1}`,
      completion: completions[turnIndex++] ?? Promise.resolve(completed([])),
    }),
  );
  const archiveThread = vi.fn<AgentRuntimePort["archiveThread"]>(async () => undefined);
  const openThread = vi.fn<AgentRuntimePort["openThread"]>(async () => "thread-1");
  const steerTurn = vi.fn<AgentRuntimePort["steerTurn"]>(async () => undefined);
  const port: AgentRuntimePort = {
    archiveThread,
    deleteThread: vi.fn(async () => undefined),
    listThreads: vi.fn(async () => ({ data: [] })),
    openThread,
    interruptTurn: vi.fn(async () => undefined),
    startTurn,
    steerTurn,
  };
  return { port, archiveThread, openThread, startTurn, steerTurn };
}

function completed(
  actions: Extract<AgentTurnResult, { status: "completed" }>["output"]["actions"],
): AgentTurnResult {
  return { status: "completed", output: { actions } };
}

function message(id: string, timestamp: string): DiscordMessage {
  return {
    id,
    timestamp,
    kind: "default",
    guild: { id: "300", name: "Luna Lab" },
    channel: { id: "200", name: "general" },
    author: { id: "100", kind: "human", username: "shun", displayName: "Shun" },
    content: id,
    attachments: [],
    stickers: [],
    reactions: [],
    mentions: { users: [], roles: [], channels: [], everyone: false },
    replyTo: null,
  };
}

function parseStartInput(raw: string | undefined): {
  history: DiscordMessage[];
  messages: DiscordMessage[];
} {
  if (raw === undefined) throw new Error("start input is missing");
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) throw new Error("start input is invalid");
  const history = Reflect.get(value, "history");
  const messages = Reflect.get(value, "messages");
  if (!Array.isArray(history) || !Array.isArray(messages))
    throw new Error("start input is invalid");
  return { history, messages };
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

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
