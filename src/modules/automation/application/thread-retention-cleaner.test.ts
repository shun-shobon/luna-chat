import { describe, expect, it, type Mock, vi } from "vitest";

import type { AgentRuntimePort } from "../../agent/ports/outbound/agent-runtime-port";
import type { AutomationClockPort, AutomationTimerHandle } from "../ports/automation-clock-port";
import type { AutomationLogPort } from "../ports/automation-log-port";

import { ThreadRetentionCleaner } from "./thread-retention-cleaner";

describe("ThreadRetentionCleaner", () => {
  it("startup直後に全pageを調べ、保持期限を過ぎたthreadだけを削除する", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const nowSeconds = now.getTime() / 1_000;
    const agent = createAgent({
      listThreads: vi
        .fn<AgentRuntimePort["listThreads"]>()
        .mockResolvedValueOnce({
          data: [
            { archived: true, id: "expired", updatedAt: nowSeconds - 101 },
            { archived: true, id: "boundary", updatedAt: nowSeconds - 100 },
            { archived: true, id: "unknown", updatedAt: undefined },
          ],
          nextCursor: "next",
        })
        .mockResolvedValueOnce({
          data: [{ archived: true, id: "current", updatedAt: nowSeconds - 99 }],
        }),
    });
    const clock = new FakeClock(now);
    const logger = createLogger();
    const cleaner = new ThreadRetentionCleaner({
      agent,
      cleanupIntervalMs: 1_000,
      clock,
      logger,
      retentionMs: 100_000,
    });

    await cleaner.start();

    expect(agent.listThreads).toHaveBeenNthCalledWith(1, { archived: true, cursor: undefined });
    expect(agent.listThreads).toHaveBeenNthCalledWith(2, { archived: true, cursor: "next" });
    expect(agent.deleteThread).toHaveBeenCalledTimes(1);
    expect(agent.deleteThread).toHaveBeenCalledWith("expired");
    expect(logger.warn).toHaveBeenCalledWith("automation.thread_retention.updated_at_missing", {
      threadId: "unknown",
    });
    expect(clock.delays).toEqual([1_000]);
  });

  it("listとdeleteの失敗を記録し、完了後に次回を予約する", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const logger = createLogger();
    const deleteFailure = createAgent({
      deleteThread: vi.fn(async () => {
        throw new Error("delete failed");
      }),
      listThreads: vi.fn(async () => ({
        data: [{ archived: true, id: "expired", updatedAt: now.getTime() / 1_000 - 101 }],
      })),
    });
    const clock = new FakeClock(now);
    const cleaner = new ThreadRetentionCleaner({
      agent: deleteFailure,
      cleanupIntervalMs: 1_000,
      clock,
      logger,
      retentionMs: 100_000,
    });
    await cleaner.start();
    expect(logger.error).toHaveBeenCalledWith(
      "automation.thread_retention.delete_failed",
      expect.objectContaining({ threadId: "expired" }),
    );

    deleteFailure.listThreads.mockRejectedValueOnce(new Error("list failed"));
    await clock.fireNext();
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        "automation.thread_retention.list_failed",
        expect.any(Object),
      );
    });
    await vi.waitFor(() => {
      expect(clock.delays).toEqual([1_000]);
    });
  });

  it("stop後はactive cleanupをdrainするが次回を予約しない", async () => {
    const listing = createDeferred<{ data: [] }>();
    const agent = createAgent({
      listThreads: vi
        .fn<AgentRuntimePort["listThreads"]>()
        .mockResolvedValueOnce({ data: [] })
        .mockImplementationOnce(async () => listing.promise),
    });
    const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));
    const cleaner = new ThreadRetentionCleaner({
      agent,
      cleanupIntervalMs: 1_000,
      clock,
      logger: createLogger(),
      retentionMs: 100_000,
    });
    await cleaner.start();

    await clock.fireNext();
    cleaner.stopIntake();
    const draining = cleaner.drain();
    listing.resolve({ data: [] });
    await draining;

    expect(clock.delays).toEqual([]);
  });
});

class FakeClock implements AutomationClockPort {
  readonly #timers: Array<{
    callback: () => void;
    delayMs: number;
    handle: AutomationTimerHandle;
  }> = [];
  readonly #now: Date;

  constructor(now: Date) {
    this.#now = now;
  }

  get delays(): number[] {
    return this.#timers.map((timer) => timer.delayMs);
  }

  now(): Date {
    return this.#now;
  }

  setTimer(delayMs: number, callback: () => void): AutomationTimerHandle {
    const handle = {
      cancel: vi.fn(() => {
        const index = this.#timers.findIndex((timer) => timer.handle === handle);
        if (index >= 0) {
          this.#timers.splice(index, 1);
        }
      }),
    };
    this.#timers.push({ callback, delayMs, handle });
    return handle;
  }

  async fireNext(): Promise<void> {
    const timer = this.#timers.shift();
    if (timer === undefined) {
      throw new Error("No timer is scheduled.");
    }
    timer.callback();
    await Promise.resolve();
  }
}

function createAgent(overrides: Partial<AgentRuntimePort> = {}): {
  [Key in keyof AgentRuntimePort]: Mock<AgentRuntimePort[Key]>;
} {
  return {
    archiveThread: vi.fn(overrides.archiveThread ?? (async () => undefined)),
    deleteThread: vi.fn(overrides.deleteThread ?? (async () => undefined)),
    interruptTurn: vi.fn(overrides.interruptTurn ?? (async () => undefined)),
    listThreads: vi.fn(overrides.listThreads ?? (async () => ({ data: [] }))),
    openThread: vi.fn(overrides.openThread ?? (async () => "thread-1")),
    startTurn: vi.fn(
      overrides.startTurn ??
        (async () => ({
          completion: Promise.resolve({ outputText: "", status: "completed" }),
          turnId: "turn-1",
        })),
    ),
    steerTurn: vi.fn(overrides.steerTurn ?? (async () => undefined)),
  };
}

type LoggerStub = {
  [Key in keyof AutomationLogPort]: Mock<AutomationLogPort[Key]>;
};

function createLogger(): LoggerStub {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
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
