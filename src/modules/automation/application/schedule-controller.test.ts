import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import type { EventExecutionPort } from "../../event/ports/event-execution-port";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type { WorkspaceSchedule } from "../../workspace/domain/workspace-schedule";
import type {
	AutomationCheckResult,
	AutomationCheckRunnerPort,
} from "../ports/automation-check-runner-port";
import type { AutomationClockPort, AutomationTimerHandle } from "../ports/automation-clock-port";
import type {
	AutomationScheduleTimerPort,
	AutomationScheduleWatcherPort,
	ScheduledAutomationJob,
} from "../ports/automation-schedule-port";
import type { AutomationWorkspacePort } from "../ports/automation-workspace-port";
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

	it("登録済みjobの定義と次回発火時刻を一覧する", async () => {
		const scheduleTimer = new FakeScheduleTimer();
		const controller = createController({ scheduleTimer });

		await controller.start({
			jobs: [
				withCheck(recurring("daily", true), "test -f flag"),
				recurring("disabled", false),
				oneShot("future", "2026-01-02T00:00:00.000Z", true),
			],
		});

		expect(controller.snapshot()).toEqual([
			{
				check: "test -f flag",
				cron: "0 9 * * *",
				id: "daily",
				kind: "recurring",
				nextFireAt: null,
				prompt: "prompt-daily",
			},
			{
				check: null,
				cron: null,
				id: "future",
				kind: "one_shot",
				nextFireAt: "2026-01-02T00:00:00.000Z",
				prompt: "prompt-future",
			},
		]);
	});

	it("登録直前に期限を過ぎたone-shotを実行せずfileから削除する", async () => {
		const clock = new FakeClock();
		clock.now
			.mockReturnValueOnce(new Date("2026-01-01T00:00:00.000Z"))
			.mockReturnValueOnce(new Date("2026-01-01T00:00:02.000Z"));
		const scheduleTimer: AutomationScheduleTimerPort = {
			schedule: vi.fn(() => {
				throw new Error("Date in past. Will never be fired.");
			}),
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
		const checkRunner = createCheckRunner();
		const controller = createController({ checkRunner, executor, scheduleTimer });
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
			{
				id: "schedule-event-1",
				type: "system.schedule.fired.v1",
				source: "system/schedule",
				subject: "daily",
				occurredAt: "2026-01-01T00:00:00.000Z",
				data: { jobId: "daily", prompt: "prompt-daily", kind: "recurring" },
			},
			undefined,
		);
		expect(checkRunner.run).not.toHaveBeenCalled();
	});

	it("checkの標準出力をtrimしてdataに加え、発火時刻のeventとして実行する", async () => {
		const clock = new FakeClock();
		const checkRunner = createCheckRunner(async () => {
			clock.now.mockReturnValue(new Date("2026-01-01T00:01:00.000Z"));
			return { status: "succeeded", stdout: "\n  v1.2.0 released\n\n" };
		});
		const executor = createExecutor();
		const scheduleTimer = new FakeScheduleTimer();
		const controller = createController({ checkRunner, clock, executor, scheduleTimer });
		await controller.start({ jobs: [withCheck(recurring("release", true), "./check.sh")] });

		await scheduleTimer.recurring[0]?.onTick();

		expect(checkRunner.run).toHaveBeenCalledWith("./check.sh");
		expect(executor.execute).toHaveBeenCalledWith(
			{
				id: "schedule-event-1",
				type: "system.schedule.fired.v1",
				source: "system/schedule",
				subject: "release",
				occurredAt: "2026-01-01T00:00:00.000Z",
				data: {
					jobId: "release",
					prompt: "prompt-release",
					kind: "recurring",
					check_output: "v1.2.0 released",
				},
			},
			undefined,
		);
	});

	it.each([
		[32_000, undefined],
		[32_001, true],
	])("trim後%i文字のcheck出力を先頭32000文字に切り詰める", async (length, truncated) => {
		const checkRunner = createCheckRunner(async () => ({
			status: "succeeded",
			stdout: ` ${"a".repeat(length)} `,
		}));
		const executor = createExecutor();
		const scheduleTimer = new FakeScheduleTimer();
		const controller = createController({ checkRunner, executor, scheduleTimer });
		await controller.start({ jobs: [withCheck(recurring("usage", true), "check")] });

		await scheduleTimer.recurring[0]?.onTick();

		expect(executor.execute.mock.calls[0]?.[0].data).toStrictEqual({
			jobId: "usage",
			prompt: "prompt-usage",
			kind: "recurring",
			check_output: "a".repeat(32_000),
			...(truncated === undefined ? {} : { check_output_truncated: truncated }),
		});
	});

	it("checkの標準出力が空白だけならCodexを起動せずskipを記録する", async () => {
		const checkRunner = createCheckRunner(async () => ({ status: "succeeded", stdout: " \n\t\n" }));
		const executor = createExecutor();
		const logger = createLogger();
		const scheduleTimer = new FakeScheduleTimer();
		const controller = createController({ checkRunner, executor, logger, scheduleTimer });
		await controller.start({ jobs: [withCheck(recurring("quiet", true), "check")] });

		await scheduleTimer.recurring[0]?.onTick();

		expect(executor.execute).not.toHaveBeenCalled();
		expect(logger.log).toHaveBeenCalledWith("info", "automation.schedule.check_skipped", {
			jobId: "quiet",
		});
	});

	it.each<[string, Extract<AutomationCheckResult, { status: "failed" }>]>([
		[
			"非0終了",
			{ exitCode: 1, signal: null, status: "failed", stderr: "fetch failed", timedOut: false },
		],
		[
			"シグナル終了",
			{ exitCode: null, signal: "SIGKILL", status: "failed", stderr: "", timedOut: false },
		],
		[
			"タイムアウト",
			{ exitCode: null, signal: "SIGTERM", status: "failed", stderr: "", timedOut: true },
		],
		[
			"spawn失敗",
			{
				error: new Error("spawn ENOENT"),
				exitCode: null,
				signal: null,
				status: "failed",
				stderr: "",
				timedOut: false,
			},
		],
	])("checkの%sではCodexを起動せずerrorを記録する", async (_title, result) => {
		const checkRunner = createCheckRunner(async () => result);
		const executor = createExecutor();
		const logger = createLogger();
		const scheduleTimer = new FakeScheduleTimer();
		const controller = createController({ checkRunner, executor, logger, scheduleTimer });
		await controller.start({ jobs: [withCheck(recurring("broken", true), "check")] });

		await scheduleTimer.recurring[0]?.onTick();

		expect(executor.execute).not.toHaveBeenCalled();
		expect(logger.log).toHaveBeenCalledWith(
			"error",
			"automation.schedule.check_failed",
			{ jobId: "broken" },
			{
				error: result.error,
				exitCode: result.exitCode,
				signal: result.signal,
				timedOut: result.timedOut,
			},
			{ stderr: result.stderr },
		);
	});

	it("check失敗時の標準エラー出力は末尾2000文字だけをpayloadに渡す", async () => {
		const checkRunner = createCheckRunner(async () => ({
			exitCode: 2,
			signal: null,
			status: "failed",
			stderr: `${"x".repeat(10)}${"y".repeat(2_000)}`,
			timedOut: false,
		}));
		const logger = createLogger();
		const scheduleTimer = new FakeScheduleTimer();
		const controller = createController({ checkRunner, logger, scheduleTimer });
		await controller.start({ jobs: [withCheck(recurring("noisy", true), "check")] });

		await scheduleTimer.recurring[0]?.onTick();

		expect(logger.log).toHaveBeenCalledWith(
			"error",
			"automation.schedule.check_failed",
			{ jobId: "noisy" },
			expect.any(Object),
			{ stderr: "y".repeat(2_000) },
		);
	});

	it("check実行中の次の発火も前回を待たずに独立してcheckから実行する", async () => {
		const firstCheck = createDeferred<AutomationCheckResult>();
		const checkRunner = createCheckRunner();
		checkRunner.run
			.mockImplementationOnce(async () => await firstCheck.promise)
			.mockImplementationOnce(async () => ({ status: "succeeded", stdout: "second" }));
		const executor = createExecutor();
		const scheduleTimer = new FakeScheduleTimer();
		const controller = createController({ checkRunner, executor, scheduleTimer });
		await controller.start({ jobs: [withCheck(recurring("watch", true), "check")] });

		const firstTick = scheduleTimer.recurring[0]?.onTick();
		await scheduleTimer.recurring[0]?.onTick();
		expect(checkRunner.run).toHaveBeenCalledTimes(2);
		expect(executor.execute).toHaveBeenCalledTimes(1);

		firstCheck.resolve({ status: "succeeded", stdout: "first" });
		await firstTick;
		expect(executor.execute.mock.calls.map(([event]) => event.data)).toEqual([
			expect.objectContaining({ check_output: "second" }),
			expect.objectContaining({ check_output: "first" }),
		]);
	});

	it("checkの追加・変更・削除をjob定義の変更としてtimerを差し替える", async () => {
		const scheduleTimer = new FakeScheduleTimer();
		const workspace = createWorkspace({
			readSchedule: vi
				.fn<AutomationWorkspacePort["readSchedule"]>()
				.mockResolvedValueOnce({ jobs: [withCheck(recurring("watch", true), "./old.sh")] })
				.mockResolvedValueOnce({ jobs: [withCheck(recurring("watch", true), "./old.sh")] })
				.mockResolvedValueOnce({ jobs: [withCheck(recurring("watch", true), "./new.sh")] })
				.mockResolvedValueOnce({ jobs: [recurring("watch", true)] }),
		});
		const checkRunner = createCheckRunner();
		const controller = createController({ checkRunner, scheduleTimer, workspace });
		await controller.start({ jobs: [recurring("watch", true)] });

		await controller.reloadSchedule();
		expect(scheduleTimer.recurring).toHaveLength(2);
		await controller.reloadSchedule();
		expect(scheduleTimer.recurring).toHaveLength(2);
		await controller.reloadSchedule();
		expect(scheduleTimer.recurring).toHaveLength(3);
		await scheduleTimer.recurring[2]?.onTick();
		expect(checkRunner.run).toHaveBeenLastCalledWith("./new.sh");
		await controller.reloadSchedule();
		expect(scheduleTimer.recurring).toHaveLength(4);
		expect(scheduleTimer.recurring.map((timer) => timer.stop.mock.calls.length)).toEqual([
			1, 1, 1, 0,
		]);
	});

	it("停止時は実行中のcheckと、その出力によるCodex実行の完了を待ってdrainする", async () => {
		const check = createDeferred<AutomationCheckResult>();
		const checkRunner = createCheckRunner(async () => await check.promise);
		const executor = createExecutor();
		const scheduleTimer = new FakeScheduleTimer();
		const controller = createController({ checkRunner, executor, scheduleTimer });
		await controller.start({ jobs: [withCheck(recurring("watch", true), "check")] });

		const tick = scheduleTimer.recurring[0]?.onTick();
		await controller.stopIntake();
		let drained = false;
		const draining = controller.drain().then(() => {
			drained = true;
		});
		await new Promise((resolve) => {
			setImmediate(resolve);
		});
		expect(drained).toBe(false);

		check.resolve({ status: "succeeded", stdout: "changed" });
		await Promise.all([tick, draining]);
		expect(executor.execute).toHaveBeenCalledTimes(1);
	});

	it("one-shotをschedulerから先に解除し、turn/start直後のhookで最新fileから削除する", async () => {
		const scheduleTimer = new FakeScheduleTimer();
		const order: string[] = [];
		const workspace = createWorkspace({
			removeScheduleJob: () => {
				order.push("delete");
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
		expect(executor.execute).toHaveBeenCalledWith(
			{
				id: "schedule-event-1",
				type: "system.schedule.fired.v1",
				source: "system/schedule",
				subject: "once",
				occurredAt: "2026-01-01T00:00:00.000Z",
				data: { jobId: "once", prompt: "prompt-once", kind: "one_shot" },
			},
			expect.any(Function),
		);
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
		expect(logger.log).toHaveBeenCalledWith(
			"error",
			"automation.schedule.one_shot_delete_failed",
			{ jobId: "once" },
			expect.any(Object),
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
		expect(logger.log).toHaveBeenCalledWith(
			"error",
			"automation.schedule.reload_failed",
			{},
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

	schedule(cronTime: Date | string, onTick: () => Promise<void>): ScheduledAutomationJob {
		if (typeof cronTime === "string") {
			const timer = {
				at: new Date(0),
				cron: cronTime,
				nextRunAt: () => null,
				onTick,
				stop: vi.fn(),
			};
			this.recurring.push(timer);
			return timer;
		}
		const timer = { at: cronTime, cron: "", nextRunAt: () => cronTime, onTick, stop: vi.fn() };
		this.oneShots.push(timer);
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
		checkRunner?: AutomationCheckRunnerPort;
		clock?: AutomationClockPort;
		executor?: EventExecutionPort;
		logger?: LoggerPort;
		scheduleTimer?: AutomationScheduleTimerPort;
		watcher?: AutomationScheduleWatcherPort;
		workspace?: AutomationWorkspacePort;
	} = {},
): ScheduleController {
	let eventSequence = 0;
	return new ScheduleController({
		checkRunner: input.checkRunner ?? createCheckRunner(),
		clock: input.clock ?? new FakeClock(),
		createEventId: () => `schedule-event-${String(++eventSequence)}`,
		executor: input.executor ?? createExecutor(),
		logger: input.logger ?? createLogger(),
		reloadDebounceMs: 25,
		scheduleTimer: input.scheduleTimer ?? new FakeScheduleTimer(),
		watcher: input.watcher ?? new FakeWatcher(),
		workspace: input.workspace ?? createWorkspace(),
	});
}

function createExecutor(
	implementation: EventExecutionPort["execute"] = async () => ({ status: "completed" }),
): { execute: Mock<EventExecutionPort["execute"]> } {
	return { execute: vi.fn(implementation) };
}

function createCheckRunner(
	implementation: AutomationCheckRunnerPort["run"] = async () => ({
		status: "succeeded",
		stdout: "",
	}),
): { run: Mock<AutomationCheckRunnerPort["run"]> } {
	return { run: vi.fn(implementation) };
}

function createLogger(): { log: Mock<LoggerPort["log"]> } {
	return { log: vi.fn() };
}

function createWorkspace(overrides: Partial<AutomationWorkspacePort> = {}): {
	[Key in keyof AutomationWorkspacePort]: Mock<AutomationWorkspacePort[Key]>;
} {
	return {
		readHeartbeatContext: vi.fn(
			overrides.readHeartbeatContext ??
				(async () => ({ checklist: "checklist", agenda: "agenda" })),
		),
		readSchedule: vi.fn(overrides.readSchedule ?? (async () => ({ jobs: [] }))),
		removeScheduleJob: vi.fn(overrides.removeScheduleJob ?? (() => undefined)),
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

function withCheck(job: ReturnType<typeof recurring>, check: string) {
	return { ...job, check };
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
