import type {
	AgentRuntimePort,
	AgentThreadInput,
	AgentTurnResult,
} from "../../agent/ports/outbound/agent-runtime-port";
import { requiresEffectFollowUp } from "../../effect/domain/effect";
import type { EffectBatchPort } from "../../effect/ports/effect-batch-port";
import type { EffectOutputContract } from "../../effect/ports/effect-output-contract";
import { parseEffectOutputs } from "../../effect/ports/effect-output-contract";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type { LunaEvent } from "../domain/luna-event";
import type {
	EventExecutionPort,
	EventExecutionResult,
	EventExecutionStatus,
} from "../ports/event-execution-port";
import type { EventTaskBoardPort } from "../ports/event-task-board-port";

type EventThread = Readonly<{ id: string; ownerId: string }>;

type RunningExecution = {
	readonly event: LunaEvent;
	phase: EventExecutionStatus["phase"];
	readonly startedAt: string;
	threadId: string | undefined;
};

export class EventExecutor implements EventExecutionPort {
	readonly #activeOwners = new Set<string>();
	readonly #running = new Set<RunningExecution>();
	#connectionGeneration = 0;

	public constructor(
		private readonly dependencies: Readonly<{
			agent: AgentRuntimePort;
			createThreadInput: () => Promise<AgentThreadInput & { executionOwnerId: string }>;
			effectOutput: EffectOutputContract;
			effects: EffectBatchPort;
			logger: LoggerPort;
			now: () => Date;
			sleep: (milliseconds: number) => Promise<void>;
			tasks: EventTaskBoardPort;
			turnRetryDelaysMs: readonly number[];
		}>,
	) {}

	public connectionLost(): void {
		this.#connectionGeneration += 1;
		for (const ownerId of this.#activeOwners) void this.#releaseEffects(ownerId);
		this.#activeOwners.clear();
	}

	public snapshot(): readonly EventExecutionStatus[] {
		return [...this.#running].map((running) => ({
			eventId: running.event.id,
			eventSource: running.event.source,
			eventType: running.event.type,
			phase: running.phase,
			startedAt: running.startedAt,
			subject: running.event.subject ?? null,
			threadId: running.threadId ?? null,
		}));
	}

	public async execute(
		event: LunaEvent,
		afterTurnStarted?: () => Promise<void>,
	): Promise<EventExecutionResult> {
		let thread: EventThread | undefined;
		let result: EventExecutionResult;
		const running: RunningExecution = {
			event,
			phase: "opening",
			startedAt: this.dependencies.now().toISOString(),
			threadId: undefined,
		};
		this.#running.add(running);
		this.dependencies.logger.log(
			"info",
			"event.execution_started",
			{ eventId: event.id },
			{ eventSource: event.source, eventType: event.type, subject: event.subject },
			event,
		);

		try {
			thread = await this.#openThread();
			running.threadId = thread.id;
			running.phase = "turn";
			const started = await this.dependencies.agent.startTurn(thread.id, {
				input: JSON.stringify({ source: "event", event, tasks: this.dependencies.tasks.listAll() }),
				outputSchema: this.dependencies.effectOutput.jsonSchema,
			});
			const completion = this.#completeChain(
				running,
				thread,
				this.#connectionGeneration,
				started.completion,
			);
			await afterTurnStarted?.();
			await completion;
			result = { status: "completed" };
			this.dependencies.logger.log("info", "event.execution_completed", {
				eventId: event.id,
				threadId: thread.id,
			});
		} catch (error: unknown) {
			this.dependencies.logger.log(
				"error",
				"event.execution_failed",
				{ eventId: event.id, threadId: thread?.id },
				{ error, eventSource: event.source, eventType: event.type },
			);
			result = { error, status: "failed" };
		} finally {
			this.#running.delete(running);
		}

		// connectionLost が所有者を解放済みなら、そのthreadは旧接続のものなのでarchiveしない。
		if (thread !== undefined && this.#activeOwners.delete(thread.ownerId)) {
			await this.#releaseEffects(thread.ownerId);
			await this.#archiveThread(thread.id);
		}

		return result;
	}

	async #openThread(): Promise<EventThread> {
		const connectionGeneration = this.#connectionGeneration;
		const input = await this.dependencies.createThreadInput();
		if (connectionGeneration !== this.#connectionGeneration) {
			throw new Error("Codex connection was lost while preparing an event thread");
		}
		const threadId = await this.dependencies.agent.openThread(input);
		if (connectionGeneration !== this.#connectionGeneration) {
			await this.#archiveThread(threadId);
			throw new Error("Codex connection was lost while opening an event thread");
		}
		this.#activeOwners.add(input.executionOwnerId);
		return { id: threadId, ownerId: input.executionOwnerId };
	}

	async #archiveThread(threadId: string): Promise<void> {
		await this.dependencies.agent.archiveThread(threadId).catch((error: unknown) => {
			this.dependencies.logger.log("error", "event.thread_archive_failed", { threadId }, { error });
		});
	}

	async #completeChain(
		running: RunningExecution,
		thread: EventThread,
		connectionGeneration: number,
		initialCompletion: Promise<AgentTurnResult>,
	): Promise<void> {
		let completion = initialCompletion;
		let retries = 0;
		for (;;) {
			try {
				const turn = await completion;
				if (turn.status !== "completed") {
					const failure = turn.errorMessage ?? `Event turn ${turn.status}`;
					const delay = this.dependencies.turnRetryDelaysMs[retries];
					if (!turn.retryable || delay === undefined) throw new Error(failure);
					retries += 1;
					this.dependencies.logger.log(
						"warn",
						"event.turn_retry_scheduled",
						{ eventId: running.event.id, threadId: thread.id },
						{ error: failure, retries },
					);
					running.phase = "retry_wait";
					await this.dependencies.sleep(delay);
					if (connectionGeneration !== this.#connectionGeneration) {
						throw new Error("Codex connection was lost while waiting to retry");
					}
					completion = (
						await this.dependencies.agent.startTurn(thread.id, {
							input: JSON.stringify({ source: "turn_retry", error: failure }),
							outputSchema: this.dependencies.effectOutput.jsonSchema,
						})
					).completion;
					running.phase = "turn";
					continue;
				}
				retries = 0;
				const output = parseEffectOutputs(this.dependencies.effectOutput, turn.outputTexts);
				const { event } = running;
				running.phase = "effects";
				this.dependencies.logger.log(
					"info",
					"event.effects_started",
					{ eventId: event.id, threadId: thread.id },
					{ effectCount: output.effects.length },
					output.effects,
				);
				const results = await this.dependencies.effects.execute(output.effects, {
					ownerId: thread.ownerId,
					origin: { kind: "event", eventId: event.id, eventType: event.type },
				});
				this.dependencies.logger.log(
					"info",
					"event.effects_settled",
					{ eventId: event.id, threadId: thread.id },
					{
						effectCount: results.length,
						failureCount: results.filter((result) => !result.success).length,
					},
					results,
				);
				await this.#releaseEffects(thread.ownerId);
				if (connectionGeneration !== this.#connectionGeneration) {
					throw new Error("Codex connection was lost while effects were running");
				}
				if (!requiresEffectFollowUp(results)) return;
				const followUp = await this.dependencies.agent.startTurn(thread.id, {
					input: JSON.stringify({ source: "effect_results", results }),
					outputSchema: this.dependencies.effectOutput.jsonSchema,
				});
				completion = followUp.completion;
				running.phase = "turn";
			} catch (error: unknown) {
				await this.#releaseEffects(thread.ownerId);
				throw error;
			}
		}
	}

	async #releaseEffects(ownerId: string): Promise<void> {
		try {
			await this.dependencies.effects.release(ownerId);
		} catch (error: unknown) {
			this.dependencies.logger.log(
				"error",
				"event.operation_failed",
				{},
				{ error, operation: "effects/release" },
			);
		}
	}
}
