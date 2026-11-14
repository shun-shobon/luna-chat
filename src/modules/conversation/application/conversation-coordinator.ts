import { formatLocalDate } from "../../../shared/local-date";
import type {
	AgentInputMessage,
	AgentRunResult,
	ModelSelection,
} from "../../agent/ports/outbound/agent-session-port";
import type { LunaEvent } from "../../event/domain/luna-event";
import { toEventMessage } from "../../event/ports/event-message";
import type { LogContext, LoggerPort } from "../../observability/ports/logger-port";
import { describeRunFailure } from "../../tool/ports/agent-session-factory-port";
import type {
	OpenAgentSession,
	OpenedAgentSession,
} from "../../tool/ports/agent-session-factory-port";
import type {
	AcceptedConversationEvent,
	ConversationSession,
} from "../domain/conversation-session";
import type {
	ConversationPhase,
	ConversationRunPurpose,
	ConversationStatus,
} from "../domain/conversation-status";
import type { ConversationHistoryPort } from "../ports/conversation-history-port";
import type { ConversationIntentPort } from "../ports/conversation-intent-port";
import type { ConversationTaskBoardPort } from "../ports/conversation-task-board-port";

type ConversationCoordinatorOptions = Readonly<{
	debounceMs: number;
	initialHistoryLimit: number;
	sessionMemoryEnabled: boolean;
	sessionIdleMs: number;
	typingIdleMs: number;
}>;

type ConversationDependencies = Readonly<{
	history: ConversationHistoryPort;
	intents: ConversationIntentPort;
	logger: LoggerPort;
	now: () => Date;
	onBatchSettled(eventIds: readonly string[], succeeded: boolean): void;
	openSession: OpenAgentSession;
	releaseTools: (ownerId: string) => Promise<void>;
	tasks: ConversationTaskBoardPort;
}>;

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

	configure(session: ConversationSession, settings: ModelSelection): boolean {
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

	snapshot(): readonly ConversationStatus[] {
		return [...this.#actors.values()].flatMap((actor) => actor.status() ?? []);
	}

	hasSession(sessionKey: string): boolean {
		return this.#actors.get(sessionKey)?.hasSession ?? false;
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

type Command =
	| Readonly<{ kind: "configure"; settings: ModelSelection }>
	| Readonly<{ kind: "end" }>
	| Readonly<{ kind: "accept"; event: LunaEvent }>
	| Readonly<{ kind: "typing"; userId: string }>
	| Readonly<{ kind: "typing_idle"; userId: string; token: number }>
	| Readonly<{ kind: "debounce"; token: number }>
	| Readonly<{ kind: "idle"; token: number }>
	| Readonly<{
			kind: "session_ready";
			token: number;
			opened: OpenedAgentSession;
			history: readonly LunaEvent[];
			batch: readonly LunaEvent[];
	  }>
	| Readonly<{ kind: "operation_failed"; token: number; operation: string; error: unknown }>
	| Readonly<{ kind: "run_finished"; token: number; result: AgentRunResult }>
	| Readonly<{ kind: "close_finished"; token: number }>
	| Readonly<{ kind: "shutdown"; resolve: () => void }>;

class ConversationActor {
	#phase: ConversationPhase = "collecting";
	#phaseSince: Date;
	#idleDeadlineAt: Date | undefined;
	#mailbox = Promise.resolve();
	#openingBatch: LunaEvent[] = [];
	#queue: LunaEvent[] = [];
	#opened: OpenedAgentSession | undefined;
	#purpose: ConversationRunPurpose | undefined;
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
	#modelSettings: ModelSelection | undefined;
	readonly #activeEventIds = new Set<string>();

	constructor(
		private readonly session: ConversationSession,
		private readonly dependencies: ConversationDependencies,
		private readonly options: ConversationCoordinatorOptions,
		private readonly onClosed: () => void,
	) {
		this.#phaseSince = dependencies.now();
	}

	status(): ConversationStatus | undefined {
		if (this.#phase === "closed") return undefined;
		const agent = this.#opened?.session.status();
		const phase =
			this.#phase === "running" && (agent?.phase === "retry_wait" || agent?.phase === "compacting")
				? agent.phase
				: this.#phase;
		return {
			context: this.session.context,
			idleDeadlineAt:
				this.#phase === "idle" && this.#idleTimer !== undefined
					? (this.#idleDeadlineAt?.toISOString() ?? null)
					: null,
			key: this.session.key,
			modelSettings: this.#modelSettings ?? null,
			phase,
			phaseSince: this.#phaseSince.toISOString(),
			purpose: this.#purpose ?? null,
			queuedEvents: this.#openingBatch.length + this.#queue.length,
			retries: agent?.retries ?? 0,
			sessionId: agent?.id ?? null,
			source: this.session.source,
		};
	}

	accept(event: LunaEvent): void {
		this.#sessionStarted = true;
		this.#post({ kind: "accept", event });
	}

	configure(settings: ModelSelection): boolean {
		if (
			this.#phase === "closing" ||
			this.#phase === "closed" ||
			this.#endPending ||
			this.#purpose === "session_memory"
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

	async shutdown(): Promise<void> {
		if (this.#phase === "closed") return;
		await new Promise<void>((resolve) => {
			this.#post({ kind: "shutdown", resolve });
		});
	}

	#post(command: Command): void {
		this.#mailbox = this.#mailbox.then(() => {
			try {
				this.#handle(command);
			} catch (error: unknown) {
				this.#logError(error, "actor/mailbox");
				if (this.#opened !== undefined) this.#closeStale(this.#opened);
				this.#finishClose();
			}
		});
	}

	#handle(command: Command): void {
		if (command.kind === "session_ready" && !this.#matches(command.token, "opening")) {
			this.#closeStale(command.opened);
			return;
		}
		if (this.#phase === "closed") {
			if (command.kind === "shutdown") command.resolve();
			return;
		}
		switch (command.kind) {
			case "configure":
				this.#modelSettings = command.settings;
				this.#opened?.session.setModel(command.settings);
				if (
					this.#phase === "collecting" &&
					this.#opened === undefined &&
					this.#queue.length === 0
				) {
					this.#enter("idle");
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
					this.#closeSession();
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
						this.#finishClose();
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
			case "session_ready":
				this.#openingBatch = [];
				this.#opened = command.opened;
				this.#logEvent(
					"conversation.session_opened",
					{},
					{
						eventCount: command.batch.length,
						historyCount: command.history.length,
						sessionId: command.opened.session.id,
					},
				);
				this.#startRun(
					[
						...(command.history.length === 0
							? []
							: [{ kind: "history", text: JSON.stringify(command.history) }]),
						...this.#batchMessages(command.batch),
					],
					"conversation",
				);
				return;
			case "operation_failed":
				if (command.token !== this.#operationToken) return;
				this.#logError(command.error, command.operation);
				this.#openingBatch = [];
				this.#settleActive(false);
				this.#closeSession();
				return;
			case "run_finished":
				if (command.token !== this.#operationToken || this.#phase !== "running") return;
				this.#handleRunFinished(command.result);
				return;
			case "close_finished":
				if (!this.#matches(command.token, "closing")) return;
				this.#resetSession();
				this.#logEvent("conversation.session_closed", {});
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
					else this.#closeSession();
				}
		}
	}

	#handleAccept(event: LunaEvent): void {
		if (this.#endRequested || this.#purpose === "session_memory" || this.#phase === "closing") {
			this.#queue.push(event);
			return;
		}
		this.#idleToken += 1;
		this.#idleTimer?.cancel();
		this.#idleTimer = undefined;
		if (this.#phase === "running" && this.#opened !== undefined) {
			this.#activeEventIds.add(event.id);
			this.#opened.session.steer(toEventMessage(event));
			for (const intent of this.dependencies.intents.match([event])) {
				this.#opened.session.steer(intent);
			}
			return;
		}
		this.#queue.push(event);
		if (this.#phase === "idle") this.#beginCollecting(false);
		else if (this.#phase === "collecting") this.#scheduleDebounce();
	}

	#handleTyping(userId: string): void {
		const token = (this.#typingTokens.get(userId) ?? 0) + 1;
		this.#typingTokens.set(userId, token);
		this.#typingTimers.get(userId)?.cancel();
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
		if (this.#opened !== undefined) {
			this.#startRun(this.#batchMessages(batch), "conversation");
			return;
		}

		const token = ++this.#operationToken;
		this.#enter("opening");
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
			this.dependencies.openSession(
				{ kind: "conversation", session: this.session },
				this.#modelSettings,
			),
		])
			.then(([history, opened]) => {
				const batchIds = new Set(batch.map((event) => event.id));
				this.#post({
					kind: "session_ready",
					token,
					opened,
					history: history.filter((event) => !batchIds.has(event.id)).toSorted(compareEvents),
					batch,
				});
			})
			.catch((error: unknown) =>
				this.#post({ kind: "operation_failed", token, operation: "session/open", error }),
			);
	}

	#batchMessages(batch: readonly LunaEvent[]): readonly AgentInputMessage[] {
		return [
			...batch.map(toEventMessage),
			...this.dependencies.intents.match(batch),
			{ kind: "task_board", text: JSON.stringify(this.dependencies.tasks.listFor(this.session)) },
		];
	}

	#startRun(messages: readonly AgentInputMessage[], purpose: ConversationRunPurpose): void {
		const opened = this.#opened;
		if (opened === undefined) throw new Error("Conversation run requires an open session");
		const token = ++this.#operationToken;
		this.#purpose = purpose;
		this.#enter("running");
		this.#logEvent("conversation.run_started", {}, { purpose, sessionId: opened.session.id });
		opened.session.run(messages).then(
			(result) => this.#post({ kind: "run_finished", token, result }),
			(error: unknown) =>
				this.#post({ kind: "operation_failed", token, operation: "session/run", error }),
		);
	}

	#handleRunFinished(result: AgentRunResult): void {
		const opened = this.#opened;
		if (opened !== undefined) void this.#releaseTools(opened.ownerId);
		this.#logEvent(
			"conversation.run_finished",
			{},
			{ purpose: this.#purpose, sessionId: opened?.session.id, status: result.status },
			result,
		);
		if (result.status !== "completed") {
			this.#logError(new Error(describeRunFailure(result)), "session/run");
			this.#settleActive(false);
			this.#closeSession();
			return;
		}
		this.#settleActive(true);
		if (this.#purpose === "session_memory") {
			this.#closeSession();
			return;
		}
		if (this.#shutdownRequested || this.#endRequested) {
			this.#preserveSessionMemory();
			return;
		}
		if (this.#queue.length > 0) this.#beginCollecting(true);
		else {
			this.#enter("idle");
			this.#resetIdleTimer();
		}
	}

	#preserveSessionMemory(): void {
		if (this.#opened === undefined || !this.options.sessionMemoryEnabled) {
			this.#closeSession();
			return;
		}
		const date = formatLocalDate(this.dependencies.now());
		this.#startRun([{ kind: "session_end", text: JSON.stringify({ date }) }], "session_memory");
	}

	#resetIdleTimer(): void {
		if (this.#shutdownRequested) return;
		const token = ++this.#idleToken;
		this.#idleTimer?.cancel();
		this.#idleDeadlineAt = new Date(this.dependencies.now().getTime() + this.options.sessionIdleMs);
		this.#idleTimer = scheduleTimeout(
			() => this.#post({ kind: "idle", token }),
			this.options.sessionIdleMs,
		);
	}

	#beginCollecting(immediate: boolean): void {
		this.#enter("collecting");
		this.#debounceReady = immediate;
		if (immediate) this.#tryBeginBatch();
		else this.#scheduleDebounce();
	}

	#closeSession(): void {
		this.#settleActive(false);
		const opened = this.#opened;
		if (opened === undefined) {
			this.#resetSession();
			this.#continueOrClose();
			return;
		}
		const token = ++this.#operationToken;
		this.#enter("closing");
		void (async () => {
			await this.#releaseTools(opened.ownerId);
			await opened.session.close().catch((error: unknown) => {
				this.#logError(error, "session/close");
			});
		})().then(() => this.#post({ kind: "close_finished", token }));
	}

	#closeStale(opened: OpenedAgentSession): void {
		void (async () => {
			await this.#releaseTools(opened.ownerId);
			await opened.session.close();
		})().catch((error: unknown) => {
			this.#logError(error, "session/close");
		});
	}

	#resetSession(): void {
		this.#opened = undefined;
		this.#purpose = undefined;
		this.#modelSettings = undefined;
		this.#endRequested = false;
		this.#endPending = false;
	}

	#continueOrClose(): void {
		if (this.#queue.length > 0) this.#beginCollecting(true);
		else this.#finishClose();
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

	#enter(phase: ConversationPhase): void {
		this.#phase = phase;
		this.#phaseSince = this.dependencies.now();
	}

	#matches(token: number, phase: ConversationPhase): boolean {
		return token === this.#operationToken && this.#phase === phase;
	}

	#finishClose(): void {
		if (this.#phase === "closed") return;
		this.#settleActive(false);
		this.#enter("closed");
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

	async #releaseTools(ownerId: string): Promise<void> {
		try {
			await this.dependencies.releaseTools(ownerId);
		} catch (error: unknown) {
			this.#logError(error, "tools/release");
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

function scheduleTimeout(callback: () => void, milliseconds: number): ScheduledTimeout {
	const timer = setTimeout(callback, milliseconds);
	return { cancel: () => clearTimeout(timer) };
}
