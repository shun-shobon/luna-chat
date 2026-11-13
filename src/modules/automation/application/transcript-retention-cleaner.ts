import type { LoggerPort } from "../../observability/ports/logger-port";
import type { AutomationClockPort, AutomationTimerHandle } from "../ports/automation-clock-port";
import type { TranscriptPrunerPort } from "../ports/transcript-pruner-port";
import { ActiveExecutionSet } from "./active-execution-set";

export class TranscriptRetentionCleaner {
	readonly #clock: AutomationClockPort;
	readonly #cleanupIntervalMs: number;
	readonly #executions = new ActiveExecutionSet();
	readonly #logger: LoggerPort;
	readonly #pruner: TranscriptPrunerPort;
	readonly #retentionMs: number;

	#accepting = false;
	#timer: AutomationTimerHandle | undefined;

	constructor(input: {
		cleanupIntervalMs: number;
		clock: AutomationClockPort;
		logger: LoggerPort;
		pruner: TranscriptPrunerPort;
		retentionMs: number;
	}) {
		this.#cleanupIntervalMs = input.cleanupIntervalMs;
		this.#clock = input.clock;
		this.#logger = input.logger;
		this.#pruner = input.pruner;
		this.#retentionMs = input.retentionMs;
	}

	start(): void {
		this.#accepting = true;
		this.#runTracked();
	}

	stopIntake(): void {
		this.#accepting = false;
		this.#timer?.cancel();
		this.#timer = undefined;
	}

	async drain(): Promise<void> {
		await this.#executions.drain();
	}

	#runTracked(): void {
		const cleanup = this.#pruner
			.prune(this.#clock.now(), this.#retentionMs)
			.catch((error: unknown) => {
				this.#logger.log("error", "automation.transcript_retention.prune_failed", {}, { error });
			})
			.finally(() => {
				if (!this.#accepting) return;
				this.#timer = this.#clock.setTimer(this.#cleanupIntervalMs, () => {
					this.#timer = undefined;
					this.#runTracked();
				});
			});
		this.#executions.track(cleanup);
	}
}
