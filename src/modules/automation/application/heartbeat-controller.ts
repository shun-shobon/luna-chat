import { randomUUID } from "node:crypto";

import type { EventExecutionPort } from "../../event/ports/event-execution-port";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type { AutomationClockPort, AutomationTimerHandle } from "../ports/automation-clock-port";
import type { AutomationWorkspacePort } from "../ports/automation-workspace-port";
import { ActiveExecutionSet } from "./active-execution-set";

export class HeartbeatController {
	readonly #clock: AutomationClockPort;
	readonly #enabled: boolean;
	readonly #executions: ActiveExecutionSet;
	readonly #createEventId: () => string;
	readonly #executor: EventExecutionPort;
	readonly #logger: LoggerPort;
	readonly #nextDelayMs: () => number;
	readonly #workspace: AutomationWorkspacePort;

	#accepting = false;
	#timer: AutomationTimerHandle | undefined;

	constructor(input: {
		clock: AutomationClockPort;
		createEventId?: (() => string) | undefined;
		enabled: boolean;
		executions?: ActiveExecutionSet;
		executor: EventExecutionPort;
		logger: LoggerPort;
		nextDelayMs: () => number;
		workspace: AutomationWorkspacePort;
	}) {
		this.#clock = input.clock;
		this.#createEventId = input.createEventId ?? randomUUID;
		this.#enabled = input.enabled;
		this.#executions = input.executions ?? new ActiveExecutionSet();
		this.#executor = input.executor;
		this.#logger = input.logger;
		this.#nextDelayMs = input.nextDelayMs;
		this.#workspace = input.workspace;
	}

	start(): void {
		if (!this.#enabled) {
			return;
		}
		this.#accepting = true;
		this.#scheduleNext();
	}

	stopIntake(): void {
		this.#accepting = false;
		this.#timer?.cancel();
		this.#timer = undefined;
	}

	async drain(): Promise<void> {
		await this.#executions.drain();
	}

	#scheduleNext(): void {
		if (!this.#accepting) {
			return;
		}

		this.#timer = this.#clock.setTimer(this.#nextDelayMs(), () => {
			this.#timer = undefined;
			const execution = this.#runOnce().finally(() => {
				this.#scheduleNext();
			});
			this.#executions.track(execution);
		});
	}

	async #runOnce(): Promise<void> {
		let context: Readonly<{ checklist: string; agenda: string }>;
		try {
			context = await this.#workspace.readHeartbeatContext();
		} catch (error: unknown) {
			this.#logger.log("error", "automation.heartbeat.context_read_failed", {}, { error });
			return;
		}

		await this.#executor.execute({
			id: this.#createEventId(),
			type: "system.heartbeat.fired.v1",
			source: "system/heartbeat",
			occurredAt: this.#clock.now().toISOString(),
			data: { checklist: context.checklist, agenda: context.agenda },
		});
	}
}
