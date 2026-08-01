import { describe, expect, it, type Mock, vi } from "vitest";

import type { AutomationClockPort, AutomationTimerHandle } from "../ports/automation-clock-port";
import type {
  AutomationScheduleTimerPort,
  ScheduledAutomationJob,
} from "../ports/automation-schedule-port";

import type { AutomationExecutionPort } from "./automation-executor";
import { MemoryMaintenanceController } from "./memory-maintenance-controller";

describe("MemoryMaintenanceController", () => {
  it("設定cronで専用automationを起動し、process local dateを渡す", async () => {
    const scheduleTimer = new FakeScheduleTimer();
    const executor = createExecutor();
    const controller = new MemoryMaintenanceController({
      clock: createClock(new Date(2026, 7, 1, 4, 0, 0)),
      cron: "0 4 * * *",
      enabled: true,
      executor,
      scheduleTimer,
    });

    controller.start();
    await scheduleTimer.fire();

    expect(scheduleTimer.cron).toBe("0 4 * * *");
    expect(executor.execute).toHaveBeenCalledWith({
      date: "2026-08-01",
      source: "memory_maintenance",
    });
  });

  it("clockが有効なYYYY-MM-DDを生成できない場合は実行を開始しない", async () => {
    const scheduleTimer = new FakeScheduleTimer();
    const executor = createExecutor();
    const controller = new MemoryMaintenanceController({
      clock: createClock(new Date(Number.NaN)),
      cron: "0 4 * * *",
      enabled: true,
      executor,
      scheduleTimer,
    });

    controller.start();

    await expect(scheduleTimer.fire()).rejects.toThrow("Memory maintenance date must be valid");
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("先行実行の完了を待たず、次のtickも並行実行する", async () => {
    const scheduleTimer = new FakeScheduleTimer();
    const first = createDeferred<void>();
    const executor = createExecutor(async () => {
      if (executor.execute.mock.calls.length === 1) {
        await first.promise;
      }
      return { status: "completed" };
    });
    const controller = new MemoryMaintenanceController({
      clock: createClock(new Date(2026, 7, 1, 4, 0, 0)),
      cron: "0 4 * * *",
      enabled: true,
      executor,
      scheduleTimer,
    });

    controller.start();
    const firstTick = scheduleTimer.fire();
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledTimes(1));
    await scheduleTimer.fire();

    expect(executor.execute).toHaveBeenCalledTimes(2);
    first.resolve();
    await firstTick;
  });

  it("無効時は登録せず、stop後はtickを無視してactive実行だけdrainする", async () => {
    const disabledTimer = new FakeScheduleTimer();
    new MemoryMaintenanceController({
      clock: createClock(new Date()),
      cron: "0 4 * * *",
      enabled: false,
      executor: createExecutor(),
      scheduleTimer: disabledTimer,
    }).start();
    expect(disabledTimer.cron).toBeUndefined();

    const scheduleTimer = new FakeScheduleTimer();
    const completion = createDeferred<void>();
    const executor = createExecutor(async () => {
      await completion.promise;
      return { status: "completed" };
    });
    const controller = new MemoryMaintenanceController({
      clock: createClock(new Date()),
      cron: "0 4 * * *",
      enabled: true,
      executor,
      scheduleTimer,
    });
    controller.start();
    const tick = scheduleTimer.fire();
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledOnce());
    controller.stopIntake();
    const draining = controller.drain();
    await scheduleTimer.fire();
    expect(executor.execute).toHaveBeenCalledOnce();
    completion.resolve();
    await Promise.all([tick, draining]);
    expect(scheduleTimer.stop).toHaveBeenCalledOnce();
  });
});

class FakeScheduleTimer implements AutomationScheduleTimerPort {
  cron: string | undefined;
  readonly stop = vi.fn();
  #onTick: (() => Promise<void>) | undefined;

  scheduleOneShot(): ScheduledAutomationJob {
    throw new Error("Unexpected one-shot schedule");
  }

  scheduleRecurring(cron: string, onTick: () => Promise<void>): ScheduledAutomationJob {
    this.cron = cron;
    this.#onTick = onTick;
    return { stop: this.stop };
  }

  async fire(): Promise<void> {
    if (this.#onTick === undefined) {
      return;
    }
    await this.#onTick();
  }
}

function createClock(now: Date): AutomationClockPort {
  return {
    now: () => now,
    setTimer(): AutomationTimerHandle {
      throw new Error("Unexpected timer");
    },
  };
}

function createExecutor(
  implementation: AutomationExecutionPort["execute"] = async () => ({ status: "completed" }),
): { execute: Mock<AutomationExecutionPort["execute"]> } {
  return { execute: vi.fn(implementation) };
}

function createDeferred<Value>(): {
  promise: Promise<Value>;
  resolve(value?: Value | PromiseLike<Value>): void;
} {
  let resolvePromise: ((value: Value | PromiseLike<Value>) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("Deferred is unavailable");
      resolvePromise(value as Value | PromiseLike<Value>);
    },
  };
}
