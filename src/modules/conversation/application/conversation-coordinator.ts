import { formatLocalDate } from "../../../shared/local-date";
import type {
	AgentRuntimePort,
	AgentThreadInput,
	AgentTurnResult,
	StartedAgentTurn,
} from "../../agent/ports/outbound/agent-runtime-port";
import { requiresEffectFollowUp } from "../../effect/domain/effect";
import type { EffectRequest, EffectResult } from "../../effect/domain/effect";
import type { EffectBatchPort } from "../../effect/ports/effect-batch-port";
import type { EffectOutputContract } from "../../effect/ports/effect-output-contract";
import type { LunaEvent } from "../../event/domain/luna-event";
import type { LogContext, LoggerPort } from "../../observability/ports/logger-port";
import type {
	AcceptedConversationEvent,
	ConversationSession,
} from "../domain/conversation-session";
import type { ConversationHistoryPort } from "../ports/conversation-history-port";

type ConversationCoordinatorOptions = Readonly<{
	debounceMs: number;
	initialHistoryLimit: number;
	sessionMemoryEnabled: boolean;
	sessionIdleMs: number;
	typingIdleMs: number;
}>;

type ConversationDependencies = Readonly<{
	agent: AgentRuntimePort;
	createThreadInput: () => Promise<AgentThreadInput>;
	effectOutput: EffectOutputContract;
	effects: EffectBatchPort;
	history: ConversationHistoryPort;
	logger: LoggerPort;
	now: () => Date;
	onBatchSettled(eventIds: readonly string[], succeeded: boolean): void;
}>;

export type ConversationModelSettings = Readonly<{ model: string; effort: string }>;

type ScheduledTimeout = Readonly<{ cancel(): void }>;

export class ConversationCoordinator {
	readonly #actors = new Map<string, ConversationActor>();
	#accepting = true;

	constructor(
		private readonly dependencies: ConversationDependencies,
		private readonly options: ConversationCoordinatorOptions,
	) {}

	accept(input: AcceptedConversationEvent): boolean {
		if (!this.#accepting) return false;
		this.#actorFor(input.session).accept(input.event);
		return true;
	}

	configure(session: ConversationSession, settings: ConversationModelSettings): boolean {
		if (!this.#accepting) return false;
		return this.#actorFor(session).configure(settings);
	}

	endSession(sessionKey: string): boolean {
		if (!this.#accepting) return false;
		const actor = this.#actors.get(sessionKey);
		if (actor === undefined || !actor.hasSession) return false;
		actor.end();
		return true;
	}

	typing(session: ConversationSession, participantId: string): void {
		if (!this.#accepting) return;
		this.#actorFor(session).typing(participantId);
	}

	stopIntake(): void {
		this.#accepting = false;
	}

	async drain(): Promise<void> {
		this.stopIntake();
		await Promise.all([...this.#actors.values()].map(async (actor) => await actor.shutdown()));
	}

	async abort(): Promise<void> {
		this.stopIntake();
		await Promise.all([...this.#actors.values()].map(async (actor) => await actor.abort()));
	}

	hasSession(sessionKey: string): boolean {
		return this.#actors.get(sessionKey)?.hasSession ?? false;
	}

	connectionLost(error: unknown): void {
		for (const actor of this.#actors.values()) actor.connectionLost(error);
	}

	#actorFor(session: ConversationSession): ConversationActor {
		const existing = this.#actors.get(session.key);
		if (existing !== undefined) return existing;
		const actor = new ConversationActor(session, this.dependencies, this.options, () => {
			this.#actors.delete(session.key);
		});
		this.#actors.set(session.key, actor);
		return actor;
	}
}

type Phase =
	| "collecting"
	| "opening"
	| "starting"
	| "turn"
	| "effects"
	| "orphaned_effects"
	| "idle"
	| "archiving"
	| "closed";

type TurnPurpose = "conversation" | "session_memory";

type ActiveThread = {
	readonly id: string;
	readonly ownerId: string;
	purpose: TurnPurpose;
	turnId: string | undefined;
};

type Command =
	| Readonly<{ kind: "configure"; settings: ConversationModelSettings }>
	| Readonly<{ kind: "end" }>
	| Readonly<{ kind: "accept"; event: LunaEvent }>
	| Readonly<{ kind: "typing"; userId: string }>
	| Readonly<{ kind: "typing_idle"; userId: string; token: number }>
	| Readonly<{ kind: "debounce"; token: number }>
	| Readonly<{ kind: "idle"; token: number }>
	| Readonly<{
			kind: "thread_ready";
			token: number;
			threadId: string;
			executionOwnerId: string;
			history: readonly LunaEvent[];
			batch: readonly LunaEvent[];
	  }>
	| Readonly<{ kind: "operation_failed"; token: number; operation: string; error: unknown }>
	| Readonly<{ kind: "turn_started"; token: number; turn: StartedAgentTurn }>
	| Readonly<{ kind: "turn_finished"; token: number; result: AgentTurnResult }>
	| Readonly<{ kind: "steer_finished"; token: number; event: LunaEvent; error?: unknown }>
	| Readonly<{ kind: "effects_finished"; token: number; results: readonly EffectResult[] }>
	| Readonly<{ kind: "archive_finished"; token: number; error?: unknown }>
	| Readonly<{ kind: "shutdown"; resolve: () => void }>
	| Readonly<{ kind: "abort"; resolve: () => void }>
	| Readonly<{ kind: "connection_lost"; error: unknown }>;

class ConversationActor {
	#phase: Phase = "collecting";
	#mailbox = Promise.resolve();
	#openingBatch: LunaEvent[] = [];
	#queue: LunaEvent[] = [];
	#steerQueue: LunaEvent[] = [];
	#steerActive: LunaEvent | undefined;
	#thread: ActiveThread | undefined;
	#turnCompletion: AgentTurnResult | undefined;
	#debounceReady = false;
	#debounceToken = 0;
	#idleToken = 0;
	#operationToken = 0;
	#typingTokens = new Map<string, number>();
	#typingTimers = new Map<string, ScheduledTimeout>();
	#debounceTimer: ScheduledTimeout | undefined;
	#idleTimer: ScheduledTimeout | undefined;
	#shutdownRequested = false;
	#shutdownWaiters: Array<() => void> = [];
	#sessionStarted = false;
	#endRequested = false;
	#endPending = false;
	#modelSettings: ConversationModelSettings | undefined;
	readonly #activeEventIds = new Set<string>();

	constructor(
		private readonly session: ConversationSession,
		private readonly dependencies: ConversationDependencies,
		private readonly options: ConversationCoordinatorOptions,
		private readonly onClosed: () => void,
	) {}

	accept(event: LunaEvent): void {
		this.#sessionStarted = true;
		this.#post({ kind: "accept", event });
	}

	configure(settings: ConversationModelSettings): boolean {
		if (
			this.#phase === "archiving" ||
			this.#phase === "closed" ||
			this.#phase === "orphaned_effects" ||
			this.#endPending ||
			this.#thread?.purpose === "session_memory"
		)
			return false;
		this.#sessionStarted = true;
		this.#post({ kind: "configure", settings });
		return true;
	}

	end(): void {
		this.#endPending = true;
		this.#post({ kind: "end" });
	}

	get hasSession(): boolean {
		return this.#sessionStarted && this.#phase !== "closed";
	}

	typing(userId: string): void {
		this.#post({ kind: "typing", userId });
	}

	connectionLost(error: unknown): void {
		this.#post({ kind: "connection_lost", error });
	}

	async shutdown(): Promise<void> {
		if (this.#phase === "closed") return;
		await new Promise<void>((resolve) => {
			this.#post({ kind: "shutdown", resolve });
		});
	}

	async abort(): Promise<void> {
		if (this.#phase === "closed") return;
		await new Promise<void>((resolve) => {
			this.#post({ kind: "abort", resolve });
		});
	}

	#post(command: Command): void {
		this.#mailbox = this.#mailbox.then(() => {
			try {
				this.#handle(command);
			} catch (error: unknown) {
				this.#logError(error, "actor/mailbox");
				this.#close();
			}
		});
	}

	#handle(command: Command): void {
		if (command.kind === "thread_ready" && !this.#matches(command.token, "opening")) {
			this.#archiveStaleThread(command.threadId);
			return;
		}
		if (this.#phase === "closed") {
			if (command.kind === "shutdown" || command.kind === "abort") command.resolve();
			return;
		}
		switch (command.kind) {
			case "configure":
				this.#modelSettings = command.settings;
				if (
					this.#phase === "collecting" &&
					this.#thread === undefined &&
					this.#queue.length === 0
				) {
					this.#phase = "idle";
					this.#resetIdleTimer();
				} else if (this.#phase === "idle") {
					this.#resetIdleTimer();
				}
				return;
			case "end":
				this.#endRequested = true;
				if (this.#phase === "idle") this.#preserveSessionMemory();
				else if (this.#phase === "collecting") {
					this.#debounceTimer?.cancel();
					this.#debounceTimer = undefined;
					this.#archive();
				}
				return;
			case "accept":
				this.#handleAccept(command.event);
				return;
			case "typing":
				this.#handleTyping(command.userId);
				return;
			case "typing_idle":
				if (this.#typingTokens.get(command.userId) === command.token) {
					this.#typingTokens.delete(command.userId);
					this.#typingTimers.delete(command.userId);
					this.#tryBeginBatch();
					if (
						this.#typingTokens.size === 0 &&
						!this.#sessionStarted &&
						this.#phase === "collecting"
					) {
						this.#close();
					}
				}
				return;
			case "debounce":
				if (command.token === this.#debounceToken && this.#phase === "collecting") {
					this.#debounceTimer = undefined;
					this.#debounceReady = true;
					this.#tryBeginBatch();
				}
				return;
			case "idle":
				if (command.token !== this.#idleToken) return;
				this.#idleTimer = undefined;
				if (this.#phase === "idle") this.#preserveSessionMemory();
				return;
			case "thread_ready":
				this.#openingBatch = [];
				this.#thread = {
					id: command.threadId,
					ownerId: command.executionOwnerId,
					purpose: "conversation",
					turnId: undefined,
				};
				this.#logEvent(
					"conversation.thread_opened",
					{ threadId: command.threadId },
					{ eventCount: command.batch.length, historyCount: command.history.length },
				);
				this.#startTurn(
					this.#thread,
					this.#conversationInput(command.history, command.batch),
					"conversation",
				);
				return;
			case "operation_failed":
				if (command.token !== this.#operationToken) return;
				this.#logError(command.error, command.operation);
				this.#archive();
				return;
			case "turn_started": {
				const thread = this.#thread;
				if (!this.#matches(command.token, "starting") || thread === undefined) return;
				this.#phase = "turn";
				thread.turnId = command.turn.turnId;
				this.#logEvent("conversation.turn_started", {
					threadId: thread.id,
					turnId: command.turn.turnId,
				});
				if (thread.purpose === "conversation" && !this.#endRequested) {
					this.#steerQueue.push(...this.#queue);
					this.#queue = [];
				}
				this.#openingBatch = [];
				this.#kickSteer();
				void command.turn.completion.then(
					(result) => this.#post({ kind: "turn_finished", token: command.token, result }),
					(error: unknown) =>
						this.#post({
							kind: "turn_finished",
							token: command.token,
							result: { status: "failed", errorMessage: errorMessage(error) },
						}),
				);
				return;
			}
			case "turn_finished":
				if (!this.#matches(command.token, "turn")) return;
				this.#turnCompletion = command.result;
				this.#logEvent(
					"conversation.turn_completed",
					{ threadId: this.#thread?.id, turnId: this.#thread?.turnId },
					{ status: command.result.status },
					command.result,
				);
				this.#finishTurnAfterSteering();
				return;
			case "steer_finished":
				if (command.token !== this.#operationToken) return;
				this.#steerActive = undefined;
				if (command.error !== undefined) {
					this.#logError(command.error, "turn/steer");
					this.#queue.push(command.event);
				} else this.#activeEventIds.add(command.event.id);
				this.#kickSteer();
				this.#finishTurnAfterSteering();
				return;
			case "effects_finished":
				if (command.token !== this.#operationToken) return;
				this.#handleEffectResults(command.results);
				return;
			case "archive_finished":
				if (!this.#matches(command.token, "archiving")) return;
				if (command.error !== undefined) {
					this.#logError(command.error, "thread/archive");
				}
				this.#resetThread();
				this.#logEvent(
					"conversation.thread_archived",
					{},
					{ success: command.error === undefined },
				);
				this.#continueOrClose();
				return;
			case "shutdown":
				this.#shutdownWaiters.push(command.resolve);
				this.#shutdownRequested = true;
				this.#clearTypingTimers();
				if (this.#phase === "idle") this.#preserveSessionMemory();
				else if (this.#phase === "collecting") {
					this.#debounceReady = true;
					if (this.#queue.length > 0) this.#tryBeginBatch();
					else this.#archive();
				}
				return;
			case "abort": {
				this.#shutdownWaiters.push(command.resolve);
				this.#shutdownRequested = true;
				this.#queue = [];
				this.#steerQueue = [];
				this.#steerActive = undefined;
				this.#clearTypingTimers();
				const ownerId = this.#thread?.ownerId;
				this.#thread = undefined;
				if (this.#phase === "effects" || this.#phase === "orphaned_effects") {
					this.#phase = "orphaned_effects";
				} else {
					if (ownerId !== undefined) void this.#releaseEffects(ownerId);
					this.#operationToken += 1;
					this.#close();
				}
				return;
			}
			case "connection_lost":
				this.#handleConnectionLost(command.error);
		}
	}

	#handleAccept(event: LunaEvent): void {
		if (
			this.#endRequested ||
			this.#thread?.purpose === "session_memory" ||
			this.#phase === "archiving"
		) {
			this.#queue.push(event);
			return;
		}
		this.#idleToken += 1;
		this.#idleTimer?.cancel();
		this.#idleTimer = undefined;
		if (this.#phase === "turn") {
			this.#steerQueue.push(event);
			this.#kickSteer();
			return;
		}
		this.#queue.push(event);
		if (this.#phase === "idle") this.#beginCollecting(false);
		else if (this.#phase === "collecting") this.#scheduleDebounce();
	}

	#handleTyping(userId: string): void {
		const token = (this.#typingTokens.get(userId) ?? 0) + 1;
		this.#typingTokens.set(userId, token);
		const currentTimer = this.#typingTimers.get(userId);
		currentTimer?.cancel();
		this.#typingTimers.set(
			userId,
			scheduleTimeout(
				() => this.#post({ kind: "typing_idle", userId, token }),
				this.options.typingIdleMs,
			),
		);
	}

	#scheduleDebounce(): void {
		this.#debounceReady = false;
		const token = ++this.#debounceToken;
		this.#debounceTimer?.cancel();
		this.#debounceTimer = scheduleTimeout(
			() => this.#post({ kind: "debounce", token }),
			this.options.debounceMs,
		);
	}

	#tryBeginBatch(): void {
		if (
			this.#phase !== "collecting" ||
			!this.#debounceReady ||
			this.#typingTokens.size > 0 ||
			this.#queue.length === 0
		) {
			return;
		}
		const batch = this.#queue.splice(0).toSorted(compareEvents);
		for (const event of batch) this.#activeEventIds.add(event.id);
		const token = ++this.#operationToken;
		if (this.#thread !== undefined) {
			this.#startTurn(this.#thread, this.#conversationInput([], batch), "conversation");
			return;
		}

		this.#phase = "opening";
		this.#openingBatch = [...batch];
		const beforeEvent = batch[0];
		if (beforeEvent === undefined) throw new Error("Conversation batch must not be empty");
		void Promise.all([
			this.dependencies.history
				.fetchBefore(this.session, beforeEvent, this.options.initialHistoryLimit)
				.catch((error: unknown) => {
					this.#logError(error, "history/fetch");
					return [];
				}),
			this.dependencies.createThreadInput(),
		])
			.then(async ([history, input]) => {
				if (!this.#matches(token, "opening")) return;
				const threadId = await this.dependencies.agent.openThread(input);
				const batchIds = new Set(batch.map((event) => event.id));
				const deduplicatedHistory = history
					.filter((event) => !batchIds.has(event.id))
					.toSorted(compareEvents);
				this.#post({
					kind: "thread_ready",
					token,
					threadId,
					executionOwnerId: input.executionOwnerId,
					history: deduplicatedHistory,
					batch,
				});
			})
			.catch((error: unknown) =>
				this.#post({ kind: "operation_failed", token, operation: "thread/open", error }),
			);
	}

	#startTurn(thread: ActiveThread, input: string, purpose: TurnPurpose): void {
		const token = ++this.#operationToken;
		this.#phase = "starting";
		thread.purpose = purpose;
		void this.dependencies.agent
			.startTurn(thread.id, {
				input,
				outputSchema: this.dependencies.effectOutput.jsonSchema,
				...this.#modelSettings,
			})
			.then(
				(turn) => this.#post({ kind: "turn_started", token, turn }),
				(error: unknown) =>
					this.#post({ kind: "operation_failed", token, operation: "turn/start", error }),
			);
	}

	#kickSteer(): void {
		const thread = this.#thread;
		if (this.#phase !== "turn" || this.#steerActive !== undefined || thread?.turnId === undefined)
			return;
		const event = this.#steerQueue.shift();
		if (event === undefined) return;
		const token = this.#operationToken;
		this.#steerActive = event;
		void this.dependencies.agent
			.steerTurn(thread.id, thread.turnId, this.#conversationInput([], [event]))
			.then(
				() => this.#post({ kind: "steer_finished", token, event }),
				(error: unknown) => this.#post({ kind: "steer_finished", token, event, error }),
			);
	}

	#finishTurnAfterSteering(): void {
		const thread = this.#thread;
		if (
			this.#phase !== "turn" ||
			thread === undefined ||
			this.#turnCompletion === undefined ||
			this.#steerActive !== undefined ||
			this.#steerQueue.length > 0
		) {
			return;
		}
		const result = this.#turnCompletion;
		this.#turnCompletion = undefined;
		const { ownerId, turnId } = thread;
		thread.turnId = undefined;
		if (result.status !== "completed") {
			this.#logError(
				new Error(result.errorMessage ?? `Agent turn ended with status: ${result.status}`),
				"turn/completion",
			);
			this.#archive();
			return;
		}
		let effects: readonly EffectRequest[];
		try {
			effects = this.dependencies.effectOutput.parse(result.outputText).effects;
		} catch (error: unknown) {
			this.#logError(error, "effects/parse");
			this.#archive();
			return;
		}
		const token = this.#operationToken;
		this.#phase = "effects";
		this.#logEvent(
			"conversation.effects_started",
			{ threadId: thread.id, turnId },
			{ effectCount: effects.length },
			effects,
		);
		void (async () => {
			try {
				const results = await this.dependencies.effects.execute(effects, ownerId);
				await this.#releaseEffects(ownerId);
				this.#post({ kind: "effects_finished", token, results });
			} catch (error: unknown) {
				await this.#releaseEffects(ownerId);
				this.#post({ kind: "operation_failed", token, operation: "effects/execute", error });
			}
		})();
	}

	#handleEffectResults(results: readonly EffectResult[]): void {
		for (const result of results) {
			this.#logEvent(
				"conversation.effect_settled",
				{ effectIndex: result.index, threadId: this.#thread?.id },
				{ effectType: result.type, success: result.success, target: result.target },
			);
		}
		this.#logEvent(
			"conversation.effects_settled",
			{ threadId: this.#thread?.id },
			{
				effectCount: results.length,
				failureCount: results.filter((result) => !result.success).length,
			},
			results,
		);
		if (this.#phase === "orphaned_effects") {
			this.#settleActive(false);
			this.#continueOrClose();
			return;
		}
		const thread = this.#thread;
		if (this.#phase !== "effects" || thread === undefined) return;
		if (requiresEffectFollowUp(results)) {
			this.#startTurn(
				thread,
				JSON.stringify({ source: "effect_results", results }),
				thread.purpose,
			);
			return;
		}
		this.#settleActive(true);
		if (thread.purpose === "session_memory") {
			this.#archive();
			return;
		}
		if (this.#shutdownRequested || this.#endRequested) {
			this.#preserveSessionMemory();
			return;
		}
		if (this.#queue.length > 0) this.#beginCollecting(true);
		else {
			this.#phase = "idle";
			this.#resetIdleTimer();
		}
	}

	#preserveSessionMemory(): void {
		const thread = this.#thread;
		if (thread === undefined || !this.options.sessionMemoryEnabled) {
			this.#archive();
			return;
		}
		const date = formatLocalDate(this.dependencies.now());
		this.#startTurn(thread, JSON.stringify({ source: "session_memory", date }), "session_memory");
	}

	#resetIdleTimer(): void {
		if (this.#shutdownRequested) return;
		const token = ++this.#idleToken;
		this.#idleTimer?.cancel();
		this.#idleTimer = scheduleTimeout(
			() => this.#post({ kind: "idle", token }),
			this.options.sessionIdleMs,
		);
	}

	#beginCollecting(immediate: boolean): void {
		this.#phase = "collecting";
		this.#debounceReady = immediate;
		if (immediate) this.#tryBeginBatch();
		else this.#scheduleDebounce();
	}

	#archive(): void {
		this.#settleActive(false);
		const thread = this.#thread;
		if (thread === undefined) {
			this.#resetThread();
			this.#continueOrClose();
			return;
		}
		const token = ++this.#operationToken;
		this.#phase = "archiving";
		void (async () => {
			await this.#releaseEffects(thread.ownerId);
			await this.dependencies.agent.archiveThread(thread.id);
		})().then(
			() => this.#post({ kind: "archive_finished", token }),
			(error: unknown) => this.#post({ kind: "archive_finished", token, error }),
		);
	}

	#archiveStaleThread(threadId: string): void {
		void this.dependencies.agent.archiveThread(threadId).catch((error: unknown) => {
			this.#logError(error, "thread/archive");
		});
	}

	#handleConnectionLost(error: unknown): void {
		if (this.#phase === "opening") this.#activeEventIds.clear();
		else this.#settleActive(false);
		this.#logError(error, "agent/connection");
		if (this.#phase === "effects") {
			this.#phase = "orphaned_effects";
			this.#thread = undefined;
			return;
		}
		if (this.#phase === "opening") this.#queue.push(...this.#openingBatch);
		this.#openingBatch = [];
		this.#queue.push(...this.#steerQueue);
		this.#steerActive = undefined;
		this.#steerQueue = [];
		const ownerId = this.#thread?.ownerId;
		this.#resetThread();
		this.#operationToken += 1;
		if (ownerId !== undefined) void this.#releaseEffects(ownerId);
		this.#continueOrClose();
	}

	#conversationInput(history: readonly LunaEvent[], events: readonly LunaEvent[]): string {
		return JSON.stringify({
			source: "conversation",
			session: { key: this.session.key, source: this.session.source },
			history,
			events,
		});
	}

	#resetThread(): void {
		this.#thread = undefined;
		this.#modelSettings = undefined;
		this.#endRequested = false;
		this.#endPending = false;
	}

	#continueOrClose(): void {
		if (this.#queue.length > 0) this.#beginCollecting(true);
		else this.#close();
	}

	#logError(error: unknown, operation: string): void {
		this.dependencies.logger.log(
			"error",
			"conversation.operation_failed",
			{ conversationSession: this.session.key },
			{ error, operation },
		);
	}

	#logEvent(
		event: string,
		context: Omit<LogContext, "conversationSession">,
		details?: Readonly<Record<string, unknown>>,
		payload?: unknown,
	): void {
		this.dependencies.logger.log(
			"info",
			event,
			{ ...context, conversationSession: this.session.key },
			details,
			payload,
		);
	}

	#matches(token: number, phase: Phase): boolean {
		return token === this.#operationToken && this.#phase === phase;
	}

	#close(): void {
		if (this.#phase === "closed") return;
		this.#settleActive(false);
		this.#phase = "closed";
		this.#clearTimers();
		this.onClosed();
		for (const resolve of this.#shutdownWaiters.splice(0)) resolve();
	}

	#clearTimers(): void {
		this.#clearTypingTimers();
		this.#debounceTimer?.cancel();
		this.#idleTimer?.cancel();
		this.#debounceTimer = undefined;
		this.#idleTimer = undefined;
	}

	#clearTypingTimers(): void {
		for (const timer of this.#typingTimers.values()) timer.cancel();
		this.#typingTimers.clear();
		this.#typingTokens.clear();
	}

	async #releaseEffects(ownerId: string): Promise<void> {
		try {
			await this.dependencies.effects.release(ownerId);
		} catch (error: unknown) {
			this.#logError(error, "effects/release");
		}
	}

	#settleActive(succeeded: boolean): void {
		if (this.#activeEventIds.size === 0) return;
		const eventIds = [...this.#activeEventIds];
		this.#activeEventIds.clear();
		this.dependencies.onBatchSettled(eventIds, succeeded);
	}
}

function compareEvents(left: LunaEvent, right: LunaEvent): number {
	const timestamp = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
	if (timestamp !== 0) return timestamp;
	return left.id.localeCompare(right.id);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function scheduleTimeout(callback: () => void, milliseconds: number): ScheduledTimeout {
	const timer = setTimeout(callback, milliseconds);
	return { cancel: () => clearTimeout(timer) };
}
