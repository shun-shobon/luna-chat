import { describe, expect, it, type Mock, vi } from "vitest";

import type { WorkspaceSchedule } from "../../workspace/domain/workspace-schedule";
import type { AutomationClockPort, AutomationTimerHandle } from "../ports/automation-clock-port";
import type { AutomationLogPort } from "../ports/automation-log-port";
import type {
  AutomationScheduleTimerPort,
  AutomationScheduleWatcherPort,
  ScheduledAutomationJob,
} from "../ports/automation-schedule-port";
import type { AutomationWorkspacePort } from "../ports/automation-workspace-port";

import type { AutomationExecutionPort } from "./automation-executor";
import { ScheduleController } from "./schedule-controller";

describe("ScheduleController", () => {
  it("enabled jobだけを登録し、過去one-shotは実行せずfileから削除する", async () => {
    const scheduleTimer = new FakeScheduleTimer();
    const workspace = createWorkspace();
    const controller = createController({ scheduleTimer, workspace });
    const schedule: WorkspaceSchedule = {
      jobs: [
        recurring("active", true),
        recurring("disabled", false),
        oneShot("future", "2026-01-02T00:00:00.000Z", true),
        oneShot("past", "2025-12-31T23:59:59.000Z", true),
        oneShot("past-disabled", "2025-12-31T23:59:59.000Z", false),
      ],
    };

    await controller.start(schedule);

    expect(scheduleTimer.recurring.map((job) => job.cron)).toEqual(["0 9 * * *"]);
    expect(scheduleTimer.oneShots.map((job) => job.at.toISOString())).toEqual([
      "2026-01-02T00:00:00.000Z",
    ]);
    expect(workspace.removeScheduleJob).toHaveBeenCalledWith("past");
    expect(workspace.removeScheduleJob).toHaveBeenCalledWith("past-disabled");
  });

  it("登録直前に期限を過ぎたone-shotを実行せずfileから削除する", async () => {
    const clock = new FakeClock();
    clock.now
      .mockReturnValueOnce(new Date("2026-01-01T00:00:00.000Z"))
      .mockReturnValueOnce(new Date("2026-01-01T00:00:02.000Z"));
    const scheduleTimer: AutomationScheduleTimerPort = {
      scheduleOneShot: vi.fn(() => {
        throw new Error("Date in past. Will never be fired.");
      }),
      scheduleRecurring: vi.fn(),
    };
    const workspace = createWorkspace();
    const controller = createController({ clock, scheduleTimer, workspace });

    await controller.start({
      jobs: [oneShot("near-deadline", "2026-01-01T00:00:01.000Z", true)],
    });

    expect(workspace.removeScheduleJob).toHaveBeenCalledWith("near-deadline");
  });

  it("recurring tickを同じIDでも並行実行する", async () => {
    const firstCompletion = createDeferred<void>();
    let callCount = 0;
    const executor = createExecutor(async () => {
      callCount += 1;
      if (callCount === 1) {
        await firstCompletion.promise;
      }
      return { status: "completed" };
    });
    const scheduleTimer = new FakeScheduleTimer();
    const controller = createController({ executor, scheduleTimer });
    await controller.start({ jobs: [recurring("daily", true)] });

    const firstTick = scheduleTimer.recurring[0]?.onTick();
    const secondTick = scheduleTimer.recurring[0]?.onTick();
    await vi.waitFor(() => {
      expect(executor.execute).toHaveBeenCalledTimes(2);
    });

    firstCompletion.resolve();
    await Promise.all([firstTick, secondTick]);
    expect(executor.execute).toHaveBeenNthCalledWith(
      1,
      { jobId: "daily", prompt: "prompt-daily", source: "schedule" },
      undefined,
    );
  });

  it("one-shotをschedulerから先に解除し、turn/start直後のhookで最新fileから削除する", async () => {
    const scheduleTimer = new FakeScheduleTimer();
    const order: string[] = [];
    const workspace = createWorkspace({
      removeScheduleJob: () => {
        order.push("delete");
        return true;
      },
    });
    const executor = createExecutor(async (_input, afterTurnStarted) => {
      order.push("turn-started");
      await afterTurnStarted?.();
      order.push("completion");
      return { status: "completed" };
    });
    const controller = createController({ executor, scheduleTimer, workspace });
    await controller.start({ jobs: [oneShot("once", "2026-01-02T00:00:00.000Z", true)] });

    await scheduleTimer.oneShots[0]?.onTick();

    expect(scheduleTimer.oneShots[0]?.stop).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["turn-started", "delete", "completion"]);
    expect(workspace.removeScheduleJob).toHaveBeenCalledWith("once");
    await controller.reloadSchedule();
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it("one-shot削除失敗を記録し、同じprocessでは再実行しない", async () => {
    const scheduleTimer = new FakeScheduleTimer();
    const logger = createLogger();
    const workspace = createWorkspace({
      removeScheduleJob: vi.fn(() => {
        throw new Error("write failed");
      }),
    });
    const executor = createExecutor(async (_input, afterTurnStarted) => {
      await afterTurnStarted?.();
      return { status: "completed" };
    });
    const controller = createController({ executor, logger, scheduleTimer, workspace });
    await controller.start({ jobs: [oneShot("once", "2026-01-02T00:00:00.000Z", true)] });

    await scheduleTimer.oneShots[0]?.onTick();
    await scheduleTimer.oneShots[0]?.onTick();

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "automation.schedule.one_shot_delete_failed",
      expect.objectContaining({ jobId: "once" }),
    );
  });

  it("発火後のreloadはturn/start応答を待ち、同じIDの更新版を登録しない", async () => {
    const turnStarted = createDeferred<void>();
    const scheduleTimer = new FakeScheduleTimer();
    const workspace = createWorkspace({
      readSchedule: async () => ({
        jobs: [oneShot("once", "2026-01-03T00:00:00.000Z", true)],
      }),
    });
    const executor = createExecutor(async (_input, afterTurnStarted) => {
      await turnStarted.promise;
      await afterTurnStarted?.();
      return { status: "completed" };
    });
    const controller = createController({ executor, scheduleTimer, workspace });
    await controller.start({ jobs: [oneShot("once", "2026-01-02T00:00:00.000Z", true)] });

    const tick = scheduleTimer.oneShots[0]?.onTick();
    await controller.reloadSchedule();
    expect(workspace.removeScheduleJob).not.toHaveBeenCalled();
    expect(scheduleTimer.oneShots).toHaveLength(1);

    turnStarted.resolve();
    await tick;
    expect(workspace.removeScheduleJob).toHaveBeenCalledWith("once");
  });

  it("valid reloadだけを反映し、変更jobのtimerを差し替える", async () => {
    const scheduleTimer = new FakeScheduleTimer();
    const logger = createLogger();
    const workspace = createWorkspace({
      readSchedule: vi
        .fn<AutomationWorkspacePort["readSchedule"]>()
        .mockRejectedValueOnce(new Error("invalid"))
        .mockResolvedValueOnce({
          jobs: [{ ...recurring("daily", true), cron: "30 9 * * *" }],
        }),
    });
    const controller = createController({ logger, scheduleTimer, workspace });
    await controller.start({ jobs: [recurring("daily", true)] });

    await controller.reloadSchedule();
    expect(scheduleTimer.recurring).toHaveLength(1);
    expect(scheduleTimer.recurring[0]?.stop).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "automation.schedule.reload_failed",
      expect.any(Object),
    );

    await controller.reloadSchedule();
    expect(scheduleTimer.recurring).toHaveLength(2);
    expect(scheduleTimer.recurring[0]?.stop).toHaveBeenCalledTimes(1);
    expect(scheduleTimer.recurring[1]?.cron).toBe("30 9 * * *");
  });

  it("watch eventをdebounceし、停止時にwatcherとtimerを止めてactive実行をdrainする", async () => {
    const clock = new FakeClock();
    const watcher = new FakeWatcher();
    const scheduleTimer = new FakeScheduleTimer();
    const completion = createDeferred<void>();
    const executor = createExecutor(async () => {
      await completion.promise;
      return { status: "completed" };
    });
    const workspace = createWorkspace();
    const controller = createController({ clock, executor, scheduleTimer, watcher, workspace });
    await controller.start({ jobs: [recurring("daily", true)] });

    watcher.change();
    watcher.change();
    expect(clock.delays).toEqual([25]);
    await clock.fireNext();
    await vi.waitFor(() => {
      expect(workspace.readSchedule).toHaveBeenCalledTimes(1);
    });

    const tick = scheduleTimer.recurring[0]?.onTick();
    const stopping = controller.stopIntake();
    const draining = controller.drain();
    completion.resolve();
    await Promise.all([tick, stopping, draining]);
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(scheduleTimer.recurring[0]?.stop).toHaveBeenCalledTimes(1);
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

type FakeTimer = ScheduledAutomationJob & {
  at: Date;
  cron: string;
  onTick: () => Promise<void>;
  stop: ReturnType<typeof vi.fn>;
};

class FakeScheduleTimer implements AutomationScheduleTimerPort {
  readonly oneShots: FakeTimer[] = [];
  readonly recurring: FakeTimer[] = [];

  scheduleOneShot(at: Date, onTick: () => Promise<void>): ScheduledAutomationJob {
    const timer = { at, cron: "", onTick, stop: vi.fn() };
    this.oneShots.push(timer);
    return timer;
  }

  scheduleRecurring(cron: string, onTick: () => Promise<void>): ScheduledAutomationJob {
    const timer = { at: new Date(0), cron, onTick, stop: vi.fn() };
    this.recurring.push(timer);
    return timer;
  }
}

class FakeWatcher implements AutomationScheduleWatcherPort {
  readonly close = vi.fn(async () => undefined);
  #onChange: (() => void) | undefined;

  change(): void {
    this.#onChange?.();
  }

  async start(input: { onChange: () => void; onError: (error: unknown) => void }): Promise<void> {
    this.#onChange = input.onChange;
  }
}

function createController(
  input: {
    clock?: AutomationClockPort;
    executor?: AutomationExecutionPort;
    logger?: AutomationLogPort;
    scheduleTimer?: AutomationScheduleTimerPort;
    watcher?: AutomationScheduleWatcherPort;
    workspace?: AutomationWorkspacePort;
  } = {},
): ScheduleController {
  return new ScheduleController({
    clock: input.clock ?? new FakeClock(),
    executor: input.executor ?? createExecutor(),
    logger: input.logger ?? createLogger(),
    reloadDebounceMs: 25,
    scheduleTimer: input.scheduleTimer ?? new FakeScheduleTimer(),
    watcher: input.watcher ?? new FakeWatcher(),
    workspace: input.workspace ?? createWorkspace(),
  });
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

function createWorkspace(overrides: Partial<AutomationWorkspacePort> = {}): {
  [Key in keyof AutomationWorkspacePort]: Mock<AutomationWorkspacePort[Key]>;
} {
  return {
    readHeartbeatChecklist: vi.fn(overrides.readHeartbeatChecklist ?? (async () => "checklist")),
    readSchedule: vi.fn(overrides.readSchedule ?? (async () => ({ jobs: [] }))),
    removeScheduleJob: vi.fn(overrides.removeScheduleJob ?? (() => true)),
  };
}

function recurring(id: string, enabled: boolean) {
  return {
    cron: "0 9 * * *",
    enabled,
    id,
    kind: "recurring" as const,
    prompt: `prompt-${id}`,
  };
}

function oneShot(id: string, at: string, enabled: boolean) {
  return {
    at,
    enabled,
    id,
    kind: "one_shot" as const,
    prompt: `prompt-${id}`,
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
