import { describe, expect, it, type Mock, vi } from "vitest";

import type { LoggerPort } from "../../observability/ports/logger-port";
import type { LunaEvent } from "../domain/luna-event";
import type { EventAgentPort } from "../ports/event-agent-port";

import { EventExecutor } from "./event-executor";

const event: LunaEvent = {
  id: "event-1",
  type: "test.sensor.changed.v1",
  source: "test/sensor",
  occurredAt: "2026-08-09T03:00:00Z",
  data: { value: 24 },
};

describe("EventExecutor", () => {
  it("turn開始後にcallbackを呼び、完了後にthreadをarchiveする", async () => {
    const completion = createDeferred<void>();
    const calls: string[] = [];
    const agent = createEventAgent({
      openEventThread: vi.fn(async () => {
        calls.push("open");
        return "thread-1";
      }),
      startEventTurn: vi.fn(async () => {
        calls.push("start");
        return { completion: completion.promise };
      }),
      archiveThread: vi.fn(async () => {
        calls.push("archive");
      }),
    });
    const executor = new EventExecutor({ agent, logger: createLogger().port });

    const execution = executor.execute(event, async () => {
      calls.push("afterTurnStarted");
    });

    await vi.waitFor(() => {
      expect(calls).toEqual(["open", "start", "afterTurnStarted"]);
    });
    completion.resolve();

    await expect(execution).resolves.toEqual({ status: "completed" });
    expect(calls).toEqual(["open", "start", "afterTurnStarted", "archive"]);
  });

  it("turn失敗時も作成済みthreadをarchiveする", async () => {
    const failure = new Error("turn failed");
    const agent = createEventAgent({
      startEventTurn: vi.fn(async () => {
        throw failure;
      }),
    });
    const { port, log } = createLogger();
    const executor = new EventExecutor({ agent, logger: port });

    await expect(executor.execute(event)).resolves.toEqual({ error: failure, status: "failed" });
    expect(agent.archiveThread).toHaveBeenCalledWith("thread-1");
    expect(log).toHaveBeenCalledWith(
      "error",
      "event.execution_failed",
      { threadId: "thread-1" },
      { error: failure, eventSource: "test/sensor", eventType: "test.sensor.changed.v1" },
    );
  });

  it("thread作成失敗時はarchiveしない", async () => {
    const failure = new Error("open failed");
    const agent = createEventAgent({
      openEventThread: vi.fn(async () => {
        throw failure;
      }),
    });
    const executor = new EventExecutor({ agent, logger: createLogger().port });

    await expect(executor.execute(event)).resolves.toEqual({ error: failure, status: "failed" });
    expect(agent.archiveThread).not.toHaveBeenCalled();
  });

  it("archive失敗をlogし、完了結果を変更しない", async () => {
    const archiveFailure = new Error("archive failed");
    const agent = createEventAgent({
      archiveThread: vi.fn(async () => {
        throw archiveFailure;
      }),
    });
    const { port, log } = createLogger();
    const executor = new EventExecutor({ agent, logger: port });

    await expect(executor.execute(event)).resolves.toEqual({ status: "completed" });
    expect(log).toHaveBeenCalledWith(
      "error",
      "event.thread_archive_failed",
      { threadId: "thread-1" },
      { error: archiveFailure },
    );
  });

  it("実行失敗後のarchiveも失敗した場合に元の失敗結果を維持する", async () => {
    const turnFailure = new Error("turn failed");
    const archiveFailure = new Error("archive failed");
    const agent = createEventAgent({
      startEventTurn: vi.fn(async () => {
        throw turnFailure;
      }),
      archiveThread: vi.fn(async () => {
        throw archiveFailure;
      }),
    });
    const executor = new EventExecutor({ agent, logger: createLogger().port });

    await expect(executor.execute(event)).resolves.toEqual({
      error: turnFailure,
      status: "failed",
    });
  });
});

type EventAgentStub = {
  [Key in keyof EventAgentPort]: Mock<EventAgentPort[Key]>;
};

function createEventAgent(overrides: Partial<EventAgentPort> = {}): EventAgentStub {
  return {
    archiveThread: vi.fn(overrides.archiveThread ?? (async () => {})),
    openEventThread: vi.fn(overrides.openEventThread ?? (async () => "thread-1")),
    startEventTurn: vi.fn(
      overrides.startEventTurn ?? (async () => ({ completion: Promise.resolve() })),
    ),
  };
}

function createLogger(): { port: LoggerPort; log: ReturnType<typeof vi.fn<LoggerPort["log"]>> } {
  const log = vi.fn<LoggerPort["log"]>();
  return { port: { log }, log };
}

function createDeferred<Value>(): {
  promise: Promise<Value>;
  resolve: (value: Value | PromiseLike<Value>) => void;
} {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
