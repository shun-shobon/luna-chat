import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type {
  AgentRuntimePort,
  AgentTurnResult,
  StartedAgentTurn,
} from "../../agent/ports/outbound/agent-runtime-port";
import type { EffectRequest, EffectResult } from "../../effect/domain/effect";
import type { EffectBatchPort } from "../../effect/ports/effect-batch-port";
import { lunaEventSchema, type LunaEvent } from "../../event/domain/luna-event";
import type { ConversationSession } from "../domain/conversation-session";
import type { ConversationHistoryPort } from "../ports/conversation-history-port";

import {
  ConversationCoordinator,
  type ConversationSessionMemoryOptions,
} from "./conversation-coordinator";

afterEach(() => {
  vi.useRealTimers();
});

describe("ConversationCoordinator", () => {
  it("debounce後にhistoryとoccurredAt・id順batchを新threadへ渡す", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    const historyEvent = event("90", "2026-07-23T00:00:00.000Z");
    const history: ConversationHistoryPort = {
      fetchBefore: vi.fn(async () => [historyEvent, event("101", "2026-07-23T00:00:02.000Z")]),
    };
    const coordinator = createCoordinator(runtime.port, { history });

    coordinator.accept({ session, event: event("102", "2026-07-23T09:00:01.000+09:00") });
    coordinator.accept({ session, event: event("101", "2026-07-23T00:00:02.000Z") });
    coordinator.accept({ session, event: event("100", "2026-07-23T09:00:02.000+09:00") });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();

    expect(runtime.startTurn).toHaveBeenCalledOnce();
    const input = parseStartInput(runtime.startTurn.mock.calls[0]?.[1]);
    expect(input).toEqual({
      source: "conversation",
      session: { key: session.key, source: session.source },
      history: [historyEvent],
      events: [
        event("102", "2026-07-23T09:00:01.000+09:00"),
        event("100", "2026-07-23T09:00:02.000+09:00"),
        event("101", "2026-07-23T00:00:02.000Z"),
      ],
    });
    expect(runtime.startTurn.mock.calls[0]?.[1].outputSchema).toBe(effectOutput.jsonSchema);
  });

  it("active turn中の投稿を受信順に一件ずつsteerする", async () => {
    vi.useFakeTimers();
    const firstCompletion = deferred<AgentTurnResult>();
    const runtime = createRuntime([firstCompletion.promise]);
    const coordinator = createCoordinator(runtime.port);

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    coordinator.accept({ session, event: event("101", "2026-07-23T00:00:01.000Z") });
    coordinator.accept({ session, event: event("102", "2026-07-23T00:00:02.000Z") });
    await flushPromises();

    expect(runtime.steerTurn).toHaveBeenCalledTimes(2);
    expect(runtime.steerTurn.mock.calls.map((call) => JSON.parse(call[2]).events[0].id)).toEqual([
      "101",
      "102",
    ]);
    firstCompletion.resolve(completed([]));
  });

  it("最初のEventより前に始まったhuman typingが途切れるまでbatchを待つ", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    const coordinator = createCoordinator(runtime.port);

    coordinator.typing(session, "100");
    expect(coordinator.hasSession(session.key)).toBe(false);
    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(80);
    coordinator.typing(session, "100");
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

    coordinator.typing(session, "100");
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

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    coordinator.accept({ session, event: event("101", "2026-07-23T00:00:01.000Z") });
    await flushPromises();
    firstCompletion.resolve(completed([]));
    await flushPromises();

    expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    const nextInput = parseStartInput(runtime.startTurn.mock.calls[1]?.[1]);
    expect(nextInput.events.map((item) => item.id)).toEqual(["101"]);
  });

  it("final確定後のsteer拒否時に先行Effectを実行してから投稿を次turnへ移す", async () => {
    vi.useFakeTimers();
    const firstCompletion = deferred<AgentTurnResult>();
    const runtime = createRuntime([firstCompletion.promise, Promise.resolve(completed([]))]);
    runtime.steerTurn.mockRejectedValueOnce(new Error("turn already emitted final answer"));
    const execute = vi.fn<EffectBatchPort["execute"]>(async () => []);
    const coordinator = createCoordinator(runtime.port, {
      effects: {
        execute,
        release: vi.fn(async () => undefined),
      },
    });

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    coordinator.accept({ session, event: event("101", "2026-07-23T00:00:01.000Z") });
    await flushPromises();
    firstCompletion.resolve(completed([effect("first answer")]));
    await flushPromises();

    expect(execute.mock.calls[0]?.[0]).toEqual([effect("first answer")]);
    expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.startTurn.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
    const nextInput = parseStartInput(runtime.startTurn.mock.calls[1]?.[1]);
    expect(nextInput.events.map((item) => item.id)).toEqual(["101"]);
  });

  it("Effect失敗結果を同じthreadのfollow-up turnへ渡す", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime([
      Promise.resolve(completed([effect("hi")])),
      Promise.resolve(completed([])),
    ]);
    const execute = vi
      .fn<EffectBatchPort["execute"]>(async () => [])
      .mockResolvedValueOnce([
        {
          type: "test.effect",
          index: 0,
          success: false,
          target: "test",
          error: "Effect unavailable",
        },
      ]);
    const effects: EffectBatchPort = {
      execute,
      release: vi.fn(async () => undefined),
    };
    const coordinator = createCoordinator(runtime.port, { effects });

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();

    expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    const followUp = parseRequestInput(runtime.startTurn.mock.calls[1]?.[1]);
    expect(followUp).toMatchObject({
      source: "effect_results",
      results: [
        {
          type: "test.effect",
          index: 0,
          success: false,
          target: "test",
          error: "Effect unavailable",
        },
      ],
    });
    expect(runtime.startTurn.mock.calls[1]?.[1].outputSchema).toBe(effectOutput.jsonSchema);
  });

  it("Effect output parse失敗時はEffectを実行せずthreadをarchiveする", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime([Promise.resolve({ status: "completed", outputText: "{" })]);
    const execute = vi.fn<EffectBatchPort["execute"]>(async () => []);
    const onError = vi.fn();
    const coordinator = createCoordinator(runtime.port, {
      effects: { execute, release: vi.fn(async () => undefined) },
      onError,
    });

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();

    expect(execute).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      session,
      operation: "effects/parse",
    });
    expect(runtime.archiveThread).toHaveBeenCalledWith("thread-1");
  });

  it("idle期限後にthreadをarchiveしてsessionを破棄する", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    const coordinator = createCoordinator(runtime.port);

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(runtime.archiveThread).toHaveBeenCalledWith("thread-1");
    expect(coordinator.hasSession(session.key)).toBe(false);
  });

  it("idle終了時に同一threadでsession memory turnを完了してからarchiveする", async () => {
    vi.useFakeTimers();
    const memoryCompletion = deferred<AgentTurnResult>();
    const runtime = createRuntime([Promise.resolve(completed([])), memoryCompletion.promise]);
    const coordinator = createCoordinator(runtime.port, {
      sessionMemory: {
        enabled: true,
        now: () => new Date(2026, 6, 24, 3, 59, 0),
      },
    });

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    expect(runtime.startTurn.mock.calls[1]?.[0]).toBe("thread-1");
    expect(parseRequestInput(runtime.startTurn.mock.calls[1]?.[1])).toEqual({
      source: "session_memory",
      date: "2026-07-24",
    });
    expect(runtime.startTurn.mock.calls[1]?.[1].outputSchema).toBe(effectOutput.jsonSchema);
    expect(runtime.archiveThread).not.toHaveBeenCalled();

    memoryCompletion.resolve(completed([]));
    await flushPromises();

    expect(runtime.archiveThread).toHaveBeenCalledWith("thread-1");
    expect(coordinator.hasSession(session.key)).toBe(false);
  });

  it("active chain中のidle終了はchain完了後にsession memory turnを開始する", async () => {
    vi.useFakeTimers();
    const conversationCompletion = deferred<AgentTurnResult>();
    const runtime = createRuntime([conversationCompletion.promise, Promise.resolve(completed([]))]);
    const coordinator = createCoordinator(runtime.port, {
      sessionMemory: { enabled: true, now: () => new Date(2026, 6, 24) },
    });

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(runtime.startTurn).toHaveBeenCalledOnce();

    conversationCompletion.resolve(completed([]));
    await flushPromises();

    expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    expect(runtime.archiveThread).toHaveBeenCalledWith("thread-1");
  });

  it("idle終了予約後の新着は予約を取消してactive turnへsteerする", async () => {
    vi.useFakeTimers();
    const conversationCompletion = deferred<AgentTurnResult>();
    const runtime = createRuntime([conversationCompletion.promise]);
    const coordinator = createCoordinator(runtime.port, {
      sessionMemory: { enabled: true, now: () => new Date(2026, 6, 24) },
    });

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(1_000);
    coordinator.accept({ session, event: event("101", "2026-07-23T00:00:01.000Z") });
    await flushPromises();
    conversationCompletion.resolve(completed([]));
    await flushPromises();

    expect(runtime.steerTurn).toHaveBeenCalledOnce();
    expect(runtime.startTurn).toHaveBeenCalledOnce();
    expect(runtime.archiveThread).not.toHaveBeenCalled();
  });

  it("session memory turnの開始中と実行中の新着をarchive後の新threadへ渡す", async () => {
    vi.useFakeTimers();
    const memoryStarted = deferred<StartedAgentTurn>();
    const memoryCompletion = deferred<AgentTurnResult>();
    const runtime = createRuntime();
    runtime.startTurn
      .mockResolvedValueOnce({ turnId: "turn-1", completion: Promise.resolve(completed([])) })
      .mockImplementationOnce(async () => await memoryStarted.promise)
      .mockResolvedValueOnce({ turnId: "turn-3", completion: Promise.resolve(completed([])) });
    const coordinator = createCoordinator(runtime.port, {
      sessionMemory: { enabled: true, now: () => new Date(2026, 6, 24) },
    });

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    coordinator.accept({ session, event: event("101", "2026-07-23T00:00:01.000Z") });
    memoryStarted.resolve({ turnId: "turn-2", completion: memoryCompletion.promise });
    await flushPromises();
    coordinator.accept({ session, event: event("102", "2026-07-23T00:00:02.000Z") });
    memoryCompletion.resolve(completed([]));
    await flushPromises();

    expect(runtime.steerTurn).not.toHaveBeenCalled();
    expect(runtime.openThread).toHaveBeenCalledTimes(2);
    expect(
      parseStartInput(runtime.startTurn.mock.calls[2]?.[1]).events.map((item) => item.id),
    ).toEqual(["101", "102"]);
  });

  it("session memory turnのEffect失敗を同じ目的のfollow-upで完了する", async () => {
    vi.useFakeTimers();
    const memoryEffect = effect("saved");
    const runtime = createRuntime([
      Promise.resolve(completed([])),
      Promise.resolve(completed([memoryEffect])),
      Promise.resolve(completed([])),
    ]);
    const execute = vi
      .fn<EffectBatchPort["execute"]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          type: "test.effect",
          index: 0,
          success: false,
          target: "test",
          error: "Effect unavailable",
        },
      ])
      .mockResolvedValueOnce([]);
    const coordinator = createCoordinator(runtime.port, {
      effects: { execute, release: vi.fn(async () => undefined) },
      sessionMemory: { enabled: true, now: () => new Date(2026, 6, 24) },
    });

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(runtime.startTurn).toHaveBeenCalledTimes(3);
    expect(parseRequestInput(runtime.startTurn.mock.calls[2]?.[1])).toMatchObject({
      source: "effect_results",
    });
    expect(runtime.archiveThread).toHaveBeenCalledWith("thread-1");
  });

  it("session memory turn中のconnection loss後に新着queueを新threadへ渡す", async () => {
    vi.useFakeTimers();
    const memoryCompletion = deferred<AgentTurnResult>();
    const runtime = createRuntime([
      Promise.resolve(completed([])),
      memoryCompletion.promise,
      Promise.resolve(completed([])),
    ]);
    const coordinator = createCoordinator(runtime.port, {
      sessionMemory: { enabled: true, now: () => new Date(2026, 6, 24) },
    });

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    coordinator.accept({ session, event: event("101", "2026-07-23T00:00:01.000Z") });
    coordinator.connectionLost(new Error("connection lost"));
    await flushPromises();

    expect(runtime.openThread).toHaveBeenCalledTimes(2);
    expect(runtime.startTurn).toHaveBeenCalledTimes(3);
    expect(parseStartInput(runtime.startTurn.mock.calls[2]?.[1]).events[0]?.id).toBe("101");
  });

  it("session memory Effect executor例外後に新着queueを新threadへ渡す", async () => {
    vi.useFakeTimers();
    const effectStarted = deferred<void>();
    const effectFailure = deferred<void>();
    const memoryEffect = effect("saved");
    const execute = vi
      .fn<EffectBatchPort["execute"]>()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => {
        effectStarted.resolve();
        await effectFailure.promise;
        throw new Error("executor failed");
      })
      .mockResolvedValue([]);
    const runtime = createRuntime([
      Promise.resolve(completed([])),
      Promise.resolve(completed([memoryEffect])),
      Promise.resolve(completed([])),
    ]);
    const onError = vi.fn();
    const coordinator = createCoordinator(runtime.port, {
      effects: { execute, release: vi.fn(async () => undefined) },
      onError,
      sessionMemory: { enabled: true, now: () => new Date(2026, 6, 24) },
    });

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await effectStarted.promise;
    coordinator.accept({ session, event: event("101", "2026-07-23T00:00:01.000Z") });
    effectFailure.resolve();
    await flushPromises();

    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      session,
      operation: "effects/execute",
    });
    expect(runtime.openThread).toHaveBeenCalledTimes(2);
    expect(parseStartInput(runtime.startTurn.mock.calls[2]?.[1]).events[0]?.id).toBe("101");
  });

  it("session memory turnの開始または完了失敗を記録してarchiveする", async () => {
    vi.useFakeTimers();
    const startFailureRuntime = createRuntime();
    startFailureRuntime.startTurn
      .mockResolvedValueOnce({ turnId: "turn-1", completion: Promise.resolve(completed([])) })
      .mockRejectedValueOnce(new Error("memory start failed"));
    const startError = vi.fn();
    const startFailureCoordinator = createCoordinator(startFailureRuntime.port, {
      onError: startError,
      sessionMemory: { enabled: true, now: () => new Date(2026, 6, 24) },
    });
    startFailureCoordinator.accept({
      session,
      event: event("100", "2026-07-23T00:00:00.000Z"),
    });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(startError).toHaveBeenCalledWith(expect.any(Error), {
      session,
      operation: "turn/start",
    });
    expect(startFailureRuntime.archiveThread).toHaveBeenCalledWith("thread-1");

    const completionFailureRuntime = createRuntime([
      Promise.resolve(completed([])),
      Promise.resolve({ status: "failed", errorMessage: "memory failed" }),
    ]);
    const completionError = vi.fn();
    const completionFailureCoordinator = createCoordinator(completionFailureRuntime.port, {
      onError: completionError,
      sessionMemory: { enabled: true, now: () => new Date(2026, 6, 24) },
    });
    completionFailureCoordinator.accept({
      session,
      event: event("101", "2026-07-23T00:00:01.000Z"),
    });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(completionError).toHaveBeenCalledWith(expect.any(Error), {
      session,
      operation: "turn/completion",
    });
    expect(completionFailureRuntime.archiveThread).toHaveBeenCalledWith("thread-1");
  });

  it("shutdown時はactive chainを待ってsession memory turnを完了してからarchiveする", async () => {
    vi.useFakeTimers();
    const completion = deferred<AgentTurnResult>();
    const runtime = createRuntime([completion.promise]);
    const coordinator = createCoordinator(runtime.port, {
      sessionMemory: { enabled: true, now: () => new Date(2026, 6, 24) },
    });

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    const draining = coordinator.drain();
    await flushPromises();
    expect(runtime.archiveThread).not.toHaveBeenCalled();

    completion.resolve(completed([]));
    await draining;

    expect(runtime.archiveThread).toHaveBeenCalledWith("thread-1");
    expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    expect(parseRequestInput(runtime.startTurn.mock.calls[1]?.[1])).toEqual({
      source: "session_memory",
      date: "2026-07-24",
    });
    expect(coordinator.hasSession(session.key)).toBe(false);
  });

  it("shutdown時はidle期限前のthreadをsession memory turnで保存してからarchiveする", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime([Promise.resolve(completed([])), Promise.resolve(completed([]))]);
    const coordinator = createCoordinator(runtime.port, {
      sessionMemory: { enabled: true, now: () => new Date(2026, 6, 24) },
    });

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();

    await coordinator.drain();

    expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    expect(parseRequestInput(runtime.startTurn.mock.calls[1]?.[1])).toEqual({
      source: "session_memory",
      date: "2026-07-24",
    });
    expect(runtime.archiveThread).toHaveBeenCalledWith("thread-1");
  });

  it("turn失敗を記録し、Effect resourceを解放してからarchiveする", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime([
      Promise.resolve({ status: "failed", errorMessage: "model failed" }),
    ]);
    const release = vi.fn(async () => undefined);
    const effects: EffectBatchPort = {
      execute: vi.fn(async () => []),
      release,
    };
    const onError = vi.fn();
    const coordinator = createCoordinator(runtime.port, {
      effects,
      onError,
      sessionMemory: { enabled: true, now: () => new Date(2026, 6, 24) },
    });

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();

    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      session,
      operation: "turn/completion",
    });
    expect(release).toHaveBeenCalledWith("owner-1");
    expect(runtime.archiveThread).toHaveBeenCalledWith("thread-1");
    expect(runtime.startTurn).toHaveBeenCalledOnce();
  });

  it("opening中のconnection lossでは未開始batchを一度だけ新runtimeへ渡す", async () => {
    vi.useFakeTimers();
    const firstHistory = deferred<readonly LunaEvent[]>();
    const history: ConversationHistoryPort = {
      fetchBefore: vi
        .fn<ConversationHistoryPort["fetchBefore"]>()
        .mockImplementationOnce(async () => await firstHistory.promise)
        .mockResolvedValueOnce([]),
    };
    const runtime = createRuntime();
    const coordinator = createCoordinator(runtime.port, { history });

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    coordinator.connectionLost(new Error("connection lost"));
    await flushPromises();
    firstHistory.resolve([]);
    await flushPromises();

    expect(runtime.openThread).toHaveBeenCalledOnce();
    expect(runtime.startTurn).toHaveBeenCalledOnce();
    expect(parseStartInput(runtime.startTurn.mock.calls[0]?.[1]).events).toHaveLength(1);
  });

  it("orphaned effectsをsettle後、受理済みqueueを新threadで処理する", async () => {
    vi.useFakeTimers();
    const execution = deferred<readonly EffectResult[]>();
    const effects: EffectBatchPort = {
      execute: vi.fn(async () => await execution.promise),
      release: vi.fn(async () => undefined),
    };
    const runtime = createRuntime([
      Promise.resolve(completed([effect("hi")])),
      Promise.resolve(completed([])),
    ]);
    const coordinator = createCoordinator(runtime.port, { effects });

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    coordinator.connectionLost(new Error("connection lost"));
    coordinator.accept({ session, event: event("101", "2026-07-23T00:00:01.000Z") });
    await flushPromises();
    execution.resolve([
      {
        type: "test.effect",
        index: 0,
        success: true,
        target: "test",
        value: { recorded: true },
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

    coordinator.accept({ session, event: event("100", "2026-07-23T00:00:00.000Z") });
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    coordinator.accept({ session, event: event("101", "2026-07-23T00:00:01.000Z") });
    archived.resolve();
    await flushPromises();

    expect(runtime.openThread).toHaveBeenCalledTimes(2);
    expect(runtime.startTurn).toHaveBeenCalledTimes(2);
  });
});

const effectInputSchema = z.strictObject({ target: z.string(), value: z.string() });
const effectEnvelopeSchema = z.strictObject({
  effects: z.array(z.strictObject({ type: z.literal("test.effect"), input: effectInputSchema })),
});
const effectOutput = {
  jsonSchema: {
    type: "object",
    properties: { effects: { type: "array" } },
    required: ["effects"],
    additionalProperties: false,
  },
  parse: (text: string) => effectEnvelopeSchema.parse(JSON.parse(text)),
};
const session: ConversationSession = {
  key: "discord:guild_channel:300:200",
  source: "discord/main",
  context: { kind: "guild_channel", guildId: "300", channelId: "200" },
};

const conversationInputSchema = z.strictObject({
  source: z.literal("conversation"),
  session: z.strictObject({ key: z.string(), source: z.string() }),
  history: z.array(lunaEventSchema),
  events: z.array(lunaEventSchema),
});

function createCoordinator(
  agent: AgentRuntimePort,
  overrides: {
    effects?: EffectBatchPort;
    history?: ConversationHistoryPort;
    onError?: (
      error: unknown,
      context: { session: ConversationSession; operation: string },
    ) => void;
    sessionMemory?: ConversationSessionMemoryOptions;
  } = {},
): ConversationCoordinator {
  return new ConversationCoordinator(
    {
      agent,
      effectOutput,
      effects: overrides.effects ?? {
        execute: vi.fn<EffectBatchPort["execute"]>(async (effects) =>
          effects.map((effect, index) => ({
            index,
            success: true as const,
            target: effect.input,
            type: effect.type,
            value: effect.input,
          })),
        ),
        release: vi.fn(async () => undefined),
      },
      history: overrides.history ?? { fetchBefore: vi.fn(async () => []) },
      createThreadInput: vi.fn(async () => ({
        baseInstructions: "Luna",
        config: {},
        cwd: "/workspace",
        developerInstructions: "protocol",
        executionOwnerId: "owner-1",
      })),
      onError: overrides.onError ?? vi.fn(),
      onEvent: vi.fn(),
    },
    {
      debounceMs: 100,
      typingIdleMs: 50,
      sessionIdleMs: 1_000,
      initialHistoryLimit: 20,
      sessionMemory: overrides.sessionMemory ?? { enabled: false },
    },
  );
}

function createRuntime(completions: Promise<AgentTurnResult>[] = [Promise.resolve(completed([]))]) {
  let turnIndex = 0;
  const startTurn = vi.fn<AgentRuntimePort["startTurn"]>(
    async (_threadId, _request): Promise<StartedAgentTurn> => ({
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

function completed(effects: readonly EffectRequest[]): AgentTurnResult {
  return { status: "completed", outputText: JSON.stringify({ effects }) };
}

function effect(value: string): EffectRequest {
  return {
    type: "test.effect",
    input: { target: "test", value },
  };
}

function event(id: string, occurredAt: string): LunaEvent {
  return {
    id,
    type: "test.event.v1",
    source: session.source,
    subject: session.key,
    occurredAt,
    data: { value: id },
  };
}

function parseStartInput(request: Parameters<AgentRuntimePort["startTurn"]>[1] | undefined) {
  if (request === undefined) throw new Error("start request is missing");
  return conversationInputSchema.parse(JSON.parse(request.input));
}

function parseRequestInput(
  request: Parameters<AgentRuntimePort["startTurn"]>[1] | undefined,
): unknown {
  if (request === undefined) throw new Error("start request is missing");
  return JSON.parse(request.input);
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
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}
