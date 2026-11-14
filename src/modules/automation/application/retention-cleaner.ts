import { ActiveExecutionSet } from "../../../shared/active-execution-set";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type { AutomationClockPort, AutomationTimerHandle } from "../ports/automation-clock-port";
import type { RetentionPrunerPort } from "../ports/retention-pruner-port";

// 保持期間を過ぎたものを、起動時と一定間隔ごとに消す。会話記録とワークスペースのゴミ箱で使う。
export class RetentionCleaner {
	readonly #clock: AutomationClockPort;
	readonly #cleanupIntervalMs: number;
	readonly #executions = new ActiveExecutionSet();
	readonly #failureEvent: string;
	readonly #logger: LoggerPort;
	readonly #pruner: RetentionPrunerPort;
	readonly #retentionMs: number;

	#accepting = false;
	#timer: AutomationTimerHandle | undefined;

	constructor(input: {
		cleanupIntervalMs: number;
		clock: AutomationClockPort;
		failureEvent: string;
		logger: LoggerPort;
		pruner: RetentionPrunerPort;
		retentionMs: number;
	}) {
		this.#cleanupIntervalMs = input.cleanupIntervalMs;
		this.#clock = input.clock;
		this.#failureEvent = input.failureEvent;
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
				this.#logger.error(this.#failureEvent, { error });
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
