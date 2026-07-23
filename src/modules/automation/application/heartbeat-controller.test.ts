import { describe, expect, it, type Mock, vi } from "vitest";

import type { AutomationClockPort, AutomationTimerHandle } from "../ports/automation-clock-port";
import type { AutomationLogPort } from "../ports/automation-log-port";
import type { AutomationWorkspacePort } from "../ports/automation-workspace-port";

import type { AutomationExecutionPort } from "./automation-executor";
import { HeartbeatController } from "./heartbeat-controller";

describe("HeartbeatController", () => {
  it("抽選した間隔後にchecklistを読み、完了後だけ次回を予約する", async () => {
    const clock = new FakeClock();
    const completion = createDeferred<void>();
    const executor = createExecutor(async () => {
      await completion.promise;
      return { status: "completed" };
    });
    const random = { integerInclusive: vi.fn(() => 15) };
    const controller = new HeartbeatController({
      clock,
      enabled: true,
      executor,
      logger: createLogger(),
      maximumIntervalMs: 30,
      minimumIntervalMs: 10,
      random,
      workspace: createWorkspace(),
    });

    controller.start();
    expect(clock.delays).toEqual([15]);
    const tick = clock.fireNext();
    await vi.waitFor(() => {
      expect(executor.execute).toHaveBeenCalledWith({
        checklist: "checklist",
        source: "heartbeat",
      });
    });
    expect(clock.delays).toEqual([]);

    completion.resolve();
    await tick;
    await vi.waitFor(() => {
      expect(clock.delays).toEqual([15]);
    });
    expect(random.integerInclusive).toHaveBeenCalledWith(10, 30);
  });

  it("checklist読込失敗を記録し、次回を予約する", async () => {
    const clock = new FakeClock();
    const logger = createLogger();
    const executor = createExecutor();
    const workspace = createWorkspace({
      readHeartbeatChecklist: vi.fn(async () => {
        throw new Error("unreadable");
      }),
    });
    const controller = new HeartbeatController({
      clock,
      enabled: true,
      executor,
      logger,
      maximumIntervalMs: 10,
      minimumIntervalMs: 10,
      random: { integerInclusive: () => 10 },
      workspace,
    });

    controller.start();
    await clock.fireNext();
    await vi.waitFor(() => {
      expect(clock.delays).toEqual([10]);
    });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "automation.heartbeat.checklist_read_failed",
      expect.any(Object),
    );
  });

  it("無効時は開始せず、stop後はactive実行完了を待っても再予約しない", async () => {
    const disabledClock = new FakeClock();
    new HeartbeatController({
      clock: disabledClock,
      enabled: false,
      executor: createExecutor(),
      logger: createLogger(),
      maximumIntervalMs: 10,
      minimumIntervalMs: 10,
      random: { integerInclusive: () => 10 },
      workspace: createWorkspace(),
    }).start();
    expect(disabledClock.delays).toEqual([]);

    const clock = new FakeClock();
    const completion = createDeferred<void>();
    const controller = new HeartbeatController({
      clock,
      enabled: true,
      executor: createExecutor(async () => {
        await completion.promise;
        return { status: "completed" };
      }),
      logger: createLogger(),
      maximumIntervalMs: 10,
      minimumIntervalMs: 10,
      random: { integerInclusive: () => 10 },
      workspace: createWorkspace(),
    });
    controller.start();
    const tick = clock.fireNext();
    controller.stopIntake();
    const draining = controller.drain();
    completion.resolve();
    await Promise.all([tick, draining]);
    expect(clock.delays).toEqual([]);
  });
});

class FakeClock implements AutomationClockPort {
  readonly #timers: Array<{
    callback: () => void;
    delayMs: number;
    handle: AutomationTimerHandle;
  }> = [];
  readonly now = vi.fn(() => new Date("2026-01-01T00:00:00.000Z"));

  get delays(): number[] {
    return this.#timers.map((timer) => timer.delayMs);
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

function createExecutor(
  implementation: AutomationExecutionPort["execute"] = async () => ({ status: "completed" }),
): { execute: Mock<AutomationExecutionPort["execute"]> } {
  return { execute: vi.fn(implementation) };
}

type LoggerStub = {
  [Key in keyof AutomationLogPort]: Mock<AutomationLogPort[Key]>;
};

function createLogger(): LoggerStub {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function createWorkspace(
  overrides: Partial<AutomationWorkspacePort> = {},
): AutomationWorkspacePort {
  return {
    readHeartbeatChecklist: vi.fn(async () => "checklist"),
    readSchedule: vi.fn(async () => ({ jobs: [] })),
    removeScheduleJob: vi.fn(() => true),
    ...overrides,
  };
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
