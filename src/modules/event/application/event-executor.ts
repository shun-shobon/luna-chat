import type {
	AgentRuntimePort,
	AgentThreadInput,
	AgentTurnResult,
} from "../../agent/ports/outbound/agent-runtime-port";
import { requiresEffectFollowUp } from "../../effect/domain/effect";
import type { EffectBatchPort } from "../../effect/ports/effect-batch-port";
import type { EffectOutputContract } from "../../effect/ports/effect-output-contract";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type { LunaEvent } from "../domain/luna-event";
import type { EventExecutionPort, EventExecutionResult } from "../ports/event-execution-port";
import type { EventTaskBoardPort } from "../ports/event-task-board-port";

type EventThread = Readonly<{ id: string; ownerId: string }>;

export class EventExecutor implements EventExecutionPort {
	readonly #activeOwners = new Set<string>();
	#connectionGeneration = 0;

	public constructor(
		private readonly dependencies: Readonly<{
			agent: AgentRuntimePort;
			createThreadInput: () => Promise<AgentThreadInput & { executionOwnerId: string }>;
			effectOutput: EffectOutputContract;
			effects: EffectBatchPort;
			logger: LoggerPort;
			tasks: EventTaskBoardPort;
		}>,
	) {}

	public connectionLost(): void {
		this.#connectionGeneration += 1;
		for (const ownerId of this.#activeOwners) void this.#releaseEffects(ownerId);
		this.#activeOwners.clear();
	}

	public async execute(
		event: LunaEvent,
		afterTurnStarted?: () => Promise<void>,
	): Promise<EventExecutionResult> {
		let thread: EventThread | undefined;
		let result: EventExecutionResult;

		try {
			thread = await this.#openThread();
			const started = await this.dependencies.agent.startTurn(thread.id, {
				input: JSON.stringify({ source: "event", event, tasks: this.dependencies.tasks.listAll() }),
				outputSchema: this.dependencies.effectOutput.jsonSchema,
			});
			const completion = this.#completeChain(
				event,
				thread,
				this.#connectionGeneration,
				started.completion,
			);
			await afterTurnStarted?.();
			await completion;
			result = { status: "completed" };
		} catch (error: unknown) {
			this.dependencies.logger.log(
				"error",
				"event.execution_failed",
				thread === undefined ? {} : { threadId: thread.id },
				{ error, eventSource: event.source, eventType: event.type },
			);
			result = { error, status: "failed" };
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
		event: LunaEvent,
		thread: EventThread,
		connectionGeneration: number,
		initialCompletion: Promise<AgentTurnResult>,
	): Promise<void> {
		let completion = initialCompletion;
		for (;;) {
			try {
				const turn = await completion;
				if (turn.status !== "completed") {
					throw new Error(turn.errorMessage ?? `Event turn ${turn.status}`);
				}
				const output = this.dependencies.effectOutput.parse(turn.outputText);
				const results = await this.dependencies.effects.execute(output.effects, {
					ownerId: thread.ownerId,
					origin: { kind: "event", eventId: event.id, eventType: event.type },
				});
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
