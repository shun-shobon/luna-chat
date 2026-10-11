import { randomUUID } from "node:crypto";

import { formatLocalDate } from "../../../shared/local-date";
import type { EventExecutionPort } from "../../event/ports/event-execution-port";
import type { AutomationClockPort } from "../ports/automation-clock-port";
import type {
	AutomationScheduleTimerPort,
	ScheduledAutomationJob,
} from "../ports/automation-schedule-port";
import { ActiveExecutionSet } from "./active-execution-set";

export class MemoryMaintenanceController {
	readonly #clock: AutomationClockPort;
	readonly #createEventId: () => string;
	readonly #cron: string;
	readonly #enabled: boolean;
	readonly #executions: ActiveExecutionSet;
	readonly #executor: EventExecutionPort;
	readonly #scheduleTimer: AutomationScheduleTimerPort;

	#accepting = false;
	#timer: ScheduledAutomationJob | undefined;

	constructor(input: {
		clock: AutomationClockPort;
		createEventId?: (() => string) | undefined;
		cron: string;
		enabled: boolean;
		executions?: ActiveExecutionSet;
		executor: EventExecutionPort;
		scheduleTimer: AutomationScheduleTimerPort;
	}) {
		this.#clock = input.clock;
		this.#createEventId = input.createEventId ?? randomUUID;
		this.#cron = input.cron;
		this.#enabled = input.enabled;
		this.#executions = input.executions ?? new ActiveExecutionSet();
		this.#executor = input.executor;
		this.#scheduleTimer = input.scheduleTimer;
	}

	start(): void {
		if (!this.#enabled) {
			return;
		}
		this.#accepting = true;
		this.#timer = this.#scheduleTimer.schedule(this.#cron, async () => {
			if (!this.#accepting) {
				return;
			}
			const now = this.#clock.now();
			const execution = this.#executor
				.execute({
					id: this.#createEventId(),
					type: "system.memory_maintenance.fired.v1",
					source: "system/memory-maintenance",
					occurredAt: now.toISOString(),
					data: { date: formatLocalDate(now) },
				})
				.then(() => undefined);
			this.#executions.track(execution);
			await execution;
		});
	}

	stopIntake(): void {
		this.#accepting = false;
		this.#timer?.stop();
		this.#timer = undefined;
	}

	async drain(): Promise<void> {
		await this.#executions.drain();
	}
}
