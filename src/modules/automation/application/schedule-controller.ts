import { randomUUID } from "node:crypto";

import type { JsonObject } from "../../../shared/json";
import type { EventExecutionPort } from "../../event/ports/event-execution-port";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type {
	OneShotScheduleJob,
	RecurringScheduleJob,
	WorkspaceSchedule,
	WorkspaceScheduleJob,
} from "../../workspace/domain/workspace-schedule";
import type { AutomationCheckRunnerPort } from "../ports/automation-check-runner-port";
import type { AutomationClockPort, AutomationTimerHandle } from "../ports/automation-clock-port";
import type {
	AutomationScheduleTimerPort,
	AutomationScheduleWatcherPort,
	ScheduledAutomationJob,
} from "../ports/automation-schedule-port";
import type { ScheduleJobStatus } from "../ports/automation-status";
import type { AutomationWorkspacePort } from "../ports/automation-workspace-port";
import { ActiveExecutionSet } from "./active-execution-set";

type RegisteredScheduleJob = {
	definition: WorkspaceScheduleJob;
	timer: ScheduledAutomationJob;
};

type FiredOneShotState = "starting" | "delete_only";

const CHECK_OUTPUT_MAX_LENGTH = 32_000;
const CHECK_STDERR_MAX_LENGTH = 2_000;

export class ScheduleController {
	readonly #checkRunner: AutomationCheckRunnerPort;
	readonly #clock: AutomationClockPort;
	readonly #createEventId: () => string;
	readonly #executions: ActiveExecutionSet;
	readonly #executor: EventExecutionPort;
	readonly #logger: LoggerPort;
	readonly #reloadDebounceMs: number;
	readonly #scheduleTimer: AutomationScheduleTimerPort;
	readonly #watcher: AutomationScheduleWatcherPort;
	readonly #workspace: AutomationWorkspacePort;

	readonly #jobs = new Map<string, RegisteredScheduleJob>();
	readonly #firedOneShots = new Map<string, FiredOneShotState>();
	#accepting = false;
	#reloadChain: Promise<void> = Promise.resolve();
	#reloadTimer: AutomationTimerHandle | undefined;

	constructor(input: {
		checkRunner: AutomationCheckRunnerPort;
		clock: AutomationClockPort;
		createEventId?: (() => string) | undefined;
		executions?: ActiveExecutionSet;
		executor: EventExecutionPort;
		logger: LoggerPort;
		reloadDebounceMs: number;
		scheduleTimer: AutomationScheduleTimerPort;
		watcher: AutomationScheduleWatcherPort;
		workspace: AutomationWorkspacePort;
	}) {
		this.#checkRunner = input.checkRunner;
		this.#clock = input.clock;
		this.#createEventId = input.createEventId ?? randomUUID;
		this.#executions = input.executions ?? new ActiveExecutionSet();
		this.#executor = input.executor;
		this.#logger = input.logger;
		this.#reloadDebounceMs = input.reloadDebounceMs;
		this.#scheduleTimer = input.scheduleTimer;
		this.#watcher = input.watcher;
		this.#workspace = input.workspace;
	}

	async start(initialSchedule: WorkspaceSchedule): Promise<void> {
		this.#accepting = true;
		await this.#enqueueReload(() => {
			this.#applySchedule(initialSchedule);
		});
		await this.#watcher.start({
			onChange: () => {
				this.#debounceReload();
			},
			onError: (error) => {
				this.#logger.log("error", "automation.schedule.watcher_failed", {}, { error });
			},
		});
	}

	async reloadSchedule(): Promise<void> {
		await this.#enqueueReload(async () => {
			let schedule: WorkspaceSchedule;
			try {
				schedule = await this.#workspace.readSchedule();
			} catch (error: unknown) {
				this.#logger.log("error", "automation.schedule.reload_failed", {}, { error });
				return;
			}
			this.#applySchedule(schedule);
		});
	}

	async stopIntake(): Promise<void> {
		this.#accepting = false;
		this.#reloadTimer?.cancel();
		this.#reloadTimer = undefined;
		await this.#watcher.close().catch((error: unknown) => {
			this.#logger.log("error", "automation.schedule.watcher_close_failed", {}, { error });
		});
		await this.#enqueueReload(() => {
			for (const job of this.#jobs.values()) {
				job.timer.stop();
			}
			this.#jobs.clear();
			this.#firedOneShots.clear();
		});
	}

	snapshot(): readonly ScheduleJobStatus[] {
		return [...this.#jobs.values()].map(({ definition, timer }) => ({
			check: definition.kind === "recurring" ? (definition.check ?? null) : null,
			cron: definition.kind === "recurring" ? definition.cron : null,
			id: definition.id,
			kind: definition.kind,
			nextFireAt: timer.nextRunAt()?.toISOString() ?? null,
			prompt: definition.prompt,
		}));
	}

	async drain(): Promise<void> {
		await this.#executions.drain();
	}

	#debounceReload(): void {
		if (!this.#accepting) {
			return;
		}
		this.#reloadTimer?.cancel();
		this.#reloadTimer = this.#clock.setTimer(this.#reloadDebounceMs, () => {
			this.#reloadTimer = undefined;
			void this.reloadSchedule().catch((error: unknown) => {
				this.#logger.log("error", "automation.schedule.apply_failed", {}, { error });
			});
		});
	}

	#applySchedule(schedule: WorkspaceSchedule): void {
		const nowMs = this.#clock.now().getTime();
		const schedulableJobs: WorkspaceScheduleJob[] = [];
		const sourceJobIds = new Set(schedule.jobs.map((job) => job.id));

		for (const firedJobId of this.#firedOneShots.keys()) {
			if (!sourceJobIds.has(firedJobId)) {
				this.#firedOneShots.delete(firedJobId);
			}
		}

		for (const job of schedule.jobs) {
			const firedState = this.#firedOneShots.get(job.id);
			if (firedState !== undefined) {
				if (firedState === "delete_only") {
					this.#removePastOneShot(job.id);
				}
				continue;
			}
			if (job.kind === "one_shot" && Date.parse(job.at) <= nowMs) {
				this.#removePastOneShot(job.id);
				continue;
			}
			if (job.enabled) {
				schedulableJobs.push(job);
			}
		}

		const nextById = new Map(schedulableJobs.map((job) => [job.id, job]));
		for (const [jobId, registered] of this.#jobs) {
			const next = nextById.get(jobId);
			if (next === undefined || !isSameDefinition(registered.definition, next)) {
				registered.timer.stop();
				this.#jobs.delete(jobId);
			}
		}

		for (const job of schedulableJobs) {
			if (!this.#jobs.has(job.id)) {
				try {
					this.#register(job);
				} catch (error: unknown) {
					if (job.kind === "one_shot" && Date.parse(job.at) <= this.#clock.now().getTime()) {
						this.#removePastOneShot(job.id);
						continue;
					}
					throw error;
				}
			}
		}
	}

	#removePastOneShot(jobId: string): void {
		try {
			this.#workspace.removeScheduleJob(jobId);
		} catch (error: unknown) {
			this.#logger.log(
				"error",
				"automation.schedule.past_one_shot_delete_failed",
				{ jobId },
				{ error },
			);
		}
	}

	#register(job: WorkspaceScheduleJob): void {
		const onTick = async (): Promise<void> => {
			if (!this.#accepting) {
				return;
			}
			const registered = this.#jobs.get(job.id);
			if (registered === undefined || registered.definition !== job) {
				return;
			}
			if (job.kind === "one_shot") {
				registered.timer.stop();
				this.#jobs.delete(job.id);
				this.#firedOneShots.set(job.id, "starting");
			}

			const execution = this.#runJob(job).finally(() => {
				if (job.kind === "one_shot" && this.#firedOneShots.get(job.id) === "starting") {
					this.#firedOneShots.set(job.id, "delete_only");
				}
			});
			this.#executions.track(execution);
			await execution;
		};

		const timer = this.#scheduleTimer.schedule(
			job.kind === "recurring" ? job.cron : new Date(job.at),
			onTick,
		);
		this.#jobs.set(job.id, { definition: job, timer });
	}

	async #runJob(job: WorkspaceScheduleJob): Promise<void> {
		const occurredAt = this.#clock.now().toISOString();
		const data: JsonObject = { jobId: job.id, prompt: job.prompt, kind: job.kind };
		if (job.kind === "recurring" && job.check !== undefined) {
			const checkData = await this.#runCheck(job.id, job.check);
			if (checkData === undefined) {
				return;
			}
			Object.assign(data, checkData);
		}
		await this.#executor.execute(
			{
				id: this.#createEventId(),
				type: "system.schedule.fired.v1",
				source: "system/schedule",
				subject: job.id,
				occurredAt,
				data,
			},
			job.kind === "one_shot"
				? () => {
						this.#deleteStartedOneShot(job.id);
						return Promise.resolve();
					}
				: undefined,
		);
	}

	async #runCheck(jobId: string, command: string): Promise<JsonObject | undefined> {
		const result = await this.#checkRunner.run(command);
		if (result.status === "failed") {
			this.#logger.log(
				"error",
				"automation.schedule.check_failed",
				{ jobId },
				{
					error: result.error,
					exitCode: result.exitCode,
					signal: result.signal,
					timedOut: result.timedOut,
				},
				{ stderr: result.stderr.slice(-CHECK_STDERR_MAX_LENGTH) },
			);
			return undefined;
		}
		const output = result.stdout.trim();
		if (output.length === 0) {
			this.#logger.log("info", "automation.schedule.check_skipped", { jobId });
			return undefined;
		}
		if (output.length > CHECK_OUTPUT_MAX_LENGTH) {
			return {
				check_output: output.slice(0, CHECK_OUTPUT_MAX_LENGTH),
				check_output_truncated: true,
			};
		}
		return { check_output: output };
	}

	#deleteStartedOneShot(jobId: string): void {
		this.#firedOneShots.set(jobId, "delete_only");
		try {
			this.#workspace.removeScheduleJob(jobId);
		} catch (error: unknown) {
			this.#logger.log("error", "automation.schedule.one_shot_delete_failed", { jobId }, { error });
		}
	}

	async #enqueueReload(operation: () => Promise<void> | void): Promise<void> {
		const execution = this.#reloadChain.then(operation, operation);
		this.#reloadChain = execution.then(
			() => undefined,
			() => undefined,
		);
		await execution;
	}
}

function isSameDefinition(left: WorkspaceScheduleJob, right: WorkspaceScheduleJob): boolean {
	if (
		left.id !== right.id ||
		left.kind !== right.kind ||
		left.enabled !== right.enabled ||
		left.prompt !== right.prompt
	) {
		return false;
	}
	if (left.kind === "recurring" && right.kind === "recurring") {
		return isSameRecurringDefinition(left, right);
	}
	if (left.kind === "one_shot" && right.kind === "one_shot") {
		return isSameOneShotDefinition(left, right);
	}
	return false;
}

function isSameRecurringDefinition(
	left: RecurringScheduleJob,
	right: RecurringScheduleJob,
): boolean {
	return left.cron === right.cron && left.check === right.check;
}

function isSameOneShotDefinition(left: OneShotScheduleJob, right: OneShotScheduleJob): boolean {
	return left.at === right.at;
}
