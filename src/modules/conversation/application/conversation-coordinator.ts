import type {
  AgentRuntimePort,
  AgentThreadInput,
  AgentTurnResult,
  StartedAgentTurn,
} from "../../agent/ports/outbound/agent-runtime-port";
import type { EffectRequest, EffectResult } from "../../effect/domain/effect";
import type { EffectBatchPort } from "../../effect/ports/effect-batch-port";
import type { EffectOutputContract } from "../../effect/ports/effect-output-contract";
import type { LunaEvent } from "../../event/domain/luna-event";
import type {
  AcceptedConversationEvent,
  ConversationSession,
} from "../domain/conversation-session";
import type { ConversationHistoryPort } from "../ports/conversation-history-port";

export type ConversationSessionMemoryOptions =
  | Readonly<{ enabled: false }>
  | Readonly<{ enabled: true; now: () => Date }>;

type ConversationCoordinatorOptions = Readonly<{
  debounceMs: number;
  initialHistoryLimit: number;
  sessionMemory: ConversationSessionMemoryOptions;
  sessionIdleMs: number;
  typingIdleMs: number;
}>;

type ConversationErrorHandler = (
  error: unknown,
  context: Readonly<{ operation: string; session: ConversationSession }>,
) => void;

type ConversationEventHandler = (
  event: string,
  context: Readonly<{
    effectIndex?: number | undefined;
    session: ConversationSession;
    threadId?: string | undefined;
    turnId?: string | undefined;
  }>,
  details?: Readonly<Record<string, unknown>>,
  payload?: unknown,
) => void;

type ScheduledTimeout = Readonly<{ cancel(): void }>;

export class ConversationCoordinator {
  readonly #actors = new Map<string, ConversationActor>();
  #accepting = true;

  constructor(
    private readonly dependencies: Readonly<{
      agent: AgentRuntimePort;
      createThreadInput: () => Promise<AgentThreadInput>;
      effectOutput: EffectOutputContract;
      effects: EffectBatchPort;
      history: ConversationHistoryPort;
      onError: ConversationErrorHandler;
      onEvent: ConversationEventHandler;
    }>,
    private readonly options: ConversationCoordinatorOptions,
  ) {}

  accept(input: AcceptedConversationEvent): void {
    if (!this.#accepting) return;
    const key = input.session.key;
    let actor = this.#actors.get(key);
    if (actor === undefined) {
      actor = new ConversationActor(input.session, this.dependencies, this.options, () => {
        this.#actors.delete(key);
      });
      this.#actors.set(key, actor);
    }
    actor.accept(input.event);
  }

  typing(session: ConversationSession, participantId: string): void {
    if (!this.#accepting) return;
    const key = session.key;
    let actor = this.#actors.get(key);
    if (actor === undefined) {
      actor = new ConversationActor(session, this.dependencies, this.options, () => {
        this.#actors.delete(key);
      });
      this.#actors.set(key, actor);
    }
    actor.typing(participantId);
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

type Command =
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
  #executionOwnerId: string | undefined;
  #threadId: string | undefined;
  #turnId: string | undefined;
  #turnPurpose: TurnPurpose | undefined;
  #turnCompletion: AgentTurnResult | undefined;
  #closeRequested = false;
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

  constructor(
    private readonly session: ConversationSession,
    private readonly dependencies: Readonly<{
      agent: AgentRuntimePort;
      createThreadInput: () => Promise<AgentThreadInput>;
      effectOutput: EffectOutputContract;
      effects: EffectBatchPort;
      history: ConversationHistoryPort;
      onError: ConversationErrorHandler;
      onEvent: ConversationEventHandler;
    }>,
    private readonly options: ConversationCoordinatorOptions,
    private readonly onClosed: () => void,
  ) {}

  accept(event: LunaEvent): void {
    this.#sessionStarted = true;
    this.#post({ kind: "accept", event });
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
    await new Promise<void>((resolve) => this.#post({ kind: "shutdown", resolve }));
  }

  async abort(): Promise<void> {
    if (this.#phase === "closed") return;
    await new Promise<void>((resolve) => this.#post({ kind: "abort", resolve }));
  }

  #post(command: Command): void {
    this.#mailbox = this.#mailbox.then(
      () => {
        this.#handle(command);
      },
      (error: unknown) => {
        this.dependencies.onError(error, { session: this.session, operation: "actor/mailbox" });
        this.#close();
      },
    );
  }

  #handle(command: Command): void {
    if (this.#phase === "closed") {
      if (command.kind === "shutdown" || command.kind === "abort") command.resolve();
      return;
    }
    switch (command.kind) {
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
        else this.#closeRequested = true;
        return;
      case "thread_ready":
        if (!this.#matches(command.token, "opening")) return;
        this.#openingBatch = [];
        this.#threadId = command.threadId;
        this.#executionOwnerId = command.executionOwnerId;
        this.dependencies.onEvent(
          "conversation.thread_opened",
          { session: this.session, threadId: command.threadId },
          { eventCount: command.batch.length, historyCount: command.history.length },
        );
        this.#startTurn(
          JSON.stringify({
            source: "conversation",
            session: { key: this.session.key, source: this.session.source },
            history: command.history,
            events: command.batch,
          }),
          "conversation",
        );
        return;
      case "operation_failed":
        if (command.token !== this.#operationToken) return;
        this.dependencies.onError(command.error, {
          session: this.session,
          operation: command.operation,
        });
        this.#archive();
        return;
      case "turn_started":
        if (!this.#matches(command.token, "starting")) return;
        this.#phase = "turn";
        this.#turnId = command.turn.turnId;
        this.dependencies.onEvent("conversation.turn_started", {
          session: this.session,
          threadId: this.#threadId,
          turnId: command.turn.turnId,
        });
        if (this.#turnPurpose === "conversation") {
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
      case "turn_finished":
        if (!this.#matches(command.token, "turn")) return;
        this.#turnCompletion = command.result;
        this.dependencies.onEvent(
          "conversation.turn_completed",
          { session: this.session, threadId: this.#threadId, turnId: this.#turnId },
          { status: command.result.status },
          command.result,
        );
        this.#finishTurnAfterSteering();
        return;
      case "steer_finished":
        if (command.token !== this.#operationToken) return;
        this.#steerActive = undefined;
        if (command.error !== undefined) {
          this.dependencies.onError(command.error, {
            session: this.session,
            operation: "turn/steer",
          });
          this.#queue.push(command.event);
        }
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
          this.dependencies.onError(command.error, {
            session: this.session,
            operation: "thread/archive",
          });
        }
        this.#threadId = undefined;
        this.#executionOwnerId = undefined;
        this.#turnId = undefined;
        this.#turnPurpose = undefined;
        this.dependencies.onEvent(
          "conversation.thread_archived",
          { session: this.session },
          { success: command.error === undefined },
        );
        if (this.#queue.length > 0) this.#beginCollecting(true);
        else this.#close();
        return;
      case "shutdown":
        this.#shutdownWaiters.push(command.resolve);
        this.#shutdownRequested = true;
        this.#closeRequested = true;
        this.#clearTypingTimers();
        if (this.#phase === "idle") this.#preserveSessionMemory();
        else if (this.#phase === "collecting") {
          this.#debounceReady = true;
          if (this.#queue.length > 0) this.#tryBeginBatch();
          else this.#archive();
        }
        return;
      case "abort":
        this.#shutdownWaiters.push(command.resolve);
        this.#shutdownRequested = true;
        this.#queue = [];
        this.#steerQueue = [];
        this.#steerActive = undefined;
        this.#clearTypingTimers();
        const ownerId = this.#executionOwnerId;
        this.#threadId = undefined;
        if (this.#phase === "effects" || this.#phase === "orphaned_effects") {
          this.#phase = "orphaned_effects";
        } else {
          this.#executionOwnerId = undefined;
          if (ownerId !== undefined) void this.#releaseEffects(ownerId);
          this.#operationToken += 1;
          this.#close();
        }
        return;
      case "connection_lost":
        this.#handleConnectionLost(command.error);
    }
  }

  #handleAccept(event: LunaEvent): void {
    if (this.#turnPurpose === "session_memory" || this.#phase === "archiving") {
      this.#queue.push(event);
      return;
    }
    this.#closeRequested = false;
    this.#resetIdleTimer();
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
    const batch = this.#queue.splice(0).sort(compareEvents);
    const token = ++this.#operationToken;
    if (this.#threadId !== undefined) {
      this.#startTurn(
        JSON.stringify({
          source: "conversation",
          session: { key: this.session.key, source: this.session.source },
          history: [],
          events: batch,
        }),
        "conversation",
      );
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
          this.dependencies.onError(error, {
            session: this.session,
            operation: "history/fetch",
          });
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
          .sort(compareEvents);
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

  #startTurn(input: string, purpose: TurnPurpose): void {
    const threadId = this.#threadId;
    if (threadId === undefined) throw new Error("Cannot start a turn without a thread");
    const token = ++this.#operationToken;
    this.#phase = "starting";
    this.#turnPurpose = purpose;
    void this.dependencies.agent
      .startTurn(threadId, { input, outputSchema: this.dependencies.effectOutput.jsonSchema })
      .then(
        (turn) => this.#post({ kind: "turn_started", token, turn }),
        (error: unknown) =>
          this.#post({ kind: "operation_failed", token, operation: "turn/start", error }),
      );
  }

  #kickSteer(): void {
    if (this.#phase !== "turn" || this.#steerActive !== undefined) return;
    const event = this.#steerQueue.shift();
    if (event === undefined) return;
    const threadId = this.#threadId;
    const turnId = this.#turnId;
    if (threadId === undefined || turnId === undefined)
      throw new Error("Active turn IDs are missing");
    const token = this.#operationToken;
    this.#steerActive = event;
    void this.dependencies.agent
      .steerTurn(
        threadId,
        turnId,
        JSON.stringify({
          source: "conversation",
          session: { key: this.session.key, source: this.session.source },
          history: [],
          events: [event],
        }),
      )
      .then(
        () => this.#post({ kind: "steer_finished", token, event }),
        (error: unknown) => this.#post({ kind: "steer_finished", token, event, error }),
      );
  }

  #finishTurnAfterSteering(): void {
    if (
      this.#phase !== "turn" ||
      this.#turnCompletion === undefined ||
      this.#steerActive !== undefined ||
      this.#steerQueue.length > 0
    ) {
      return;
    }
    const result = this.#turnCompletion;
    this.#turnCompletion = undefined;
    const ownerId = this.#executionOwnerId;
    const purpose = this.#turnPurpose;
    const turnId = this.#turnId;
    this.#turnId = undefined;
    if (result.status !== "completed" || ownerId === undefined || purpose === undefined) {
      if (result.status !== "completed") {
        this.dependencies.onError(
          new Error(result.errorMessage ?? `Agent turn ended with status: ${result.status}`),
          { session: this.session, operation: "turn/completion" },
        );
      }
      this.#archive();
      return;
    }
    let effects: readonly EffectRequest[];
    try {
      effects = this.dependencies.effectOutput.parse(result.outputText).effects;
    } catch (error: unknown) {
      this.dependencies.onError(error, { session: this.session, operation: "effects/parse" });
      this.#archive();
      return;
    }
    const token = this.#operationToken;
    this.#phase = "effects";
    this.dependencies.onEvent(
      "conversation.effects_started",
      { session: this.session, threadId: this.#threadId, turnId },
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
      this.dependencies.onEvent(
        "conversation.effect_settled",
        { effectIndex: result.index, session: this.session, threadId: this.#threadId },
        { effectType: result.type, success: result.success, target: result.target },
      );
    }
    this.dependencies.onEvent(
      "conversation.effects_settled",
      { session: this.session, threadId: this.#threadId },
      {
        effectCount: results.length,
        failureCount: results.filter((result) => !result.success).length,
      },
      results,
    );
    if (this.#phase === "orphaned_effects") {
      this.#threadId = undefined;
      this.#executionOwnerId = undefined;
      this.#turnPurpose = undefined;
      if (this.#queue.length > 0) this.#beginCollecting(true);
      else this.#close();
      return;
    }
    if (this.#phase !== "effects") return;
    if (results.some((result) => !result.success)) {
      const purpose = this.#turnPurpose;
      if (purpose === undefined)
        throw new Error("Completed effect batch is missing its turn purpose");
      this.#startTurn(JSON.stringify({ source: "effect_results", results }), purpose);
      return;
    }
    if (this.#turnPurpose === "session_memory") {
      this.#archive();
      return;
    }
    if (this.#closeRequested) {
      this.#preserveSessionMemory();
      return;
    }
    this.#resetIdleTimer();
    if (this.#queue.length > 0) this.#beginCollecting(true);
    else this.#phase = "idle";
  }

  #preserveSessionMemory(): void {
    if (!this.options.sessionMemory.enabled) {
      this.#archive();
      return;
    }
    let date: string;
    try {
      date = formatLocalDate(this.options.sessionMemory.now());
    } catch (error: unknown) {
      this.dependencies.onError(error, {
        session: this.session,
        operation: "session_memory/input",
      });
      this.#archive();
      return;
    }
    this.#startTurn(JSON.stringify({ source: "session_memory", date }), "session_memory");
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
    const threadId = this.#threadId;
    if (threadId === undefined) {
      if (this.#queue.length > 0) this.#beginCollecting(true);
      else this.#close();
      return;
    }
    const token = ++this.#operationToken;
    this.#phase = "archiving";
    const ownerId = this.#executionOwnerId;
    void (async () => {
      if (ownerId !== undefined) await this.#releaseEffects(ownerId);
      await this.dependencies.agent.archiveThread(threadId);
    })().then(
      () => this.#post({ kind: "archive_finished", token }),
      (error: unknown) => this.#post({ kind: "archive_finished", token, error }),
    );
  }

  #handleConnectionLost(error: unknown): void {
    this.dependencies.onError(error, { session: this.session, operation: "agent/connection" });
    if (this.#phase === "effects") {
      this.#phase = "orphaned_effects";
      this.#threadId = undefined;
      return;
    }
    if (this.#phase === "opening") this.#queue.push(...this.#openingBatch);
    this.#openingBatch = [];
    this.#queue.push(...this.#steerQueue);
    this.#steerActive = undefined;
    this.#steerQueue = [];
    const ownerId = this.#executionOwnerId;
    this.#threadId = undefined;
    this.#executionOwnerId = undefined;
    this.#turnId = undefined;
    this.#turnPurpose = undefined;
    this.#operationToken += 1;
    if (ownerId !== undefined) void this.#releaseEffects(ownerId);
    if (this.#queue.length > 0) this.#beginCollecting(true);
    else this.#close();
  }

  #matches(token: number, phase: Phase): boolean {
    return token === this.#operationToken && this.#phase === phase;
  }

  #close(): void {
    if (this.#phase === "closed") return;
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
      this.dependencies.onError(error, { session: this.session, operation: "effects/release" });
    }
  }
}

function formatLocalDate(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error("Session memory date must be valid");
  const localYear = date.getFullYear();
  if (localYear < 0 || localYear > 9_999) {
    throw new Error("Session memory date year must fit YYYY");
  }
  const year = String(localYear).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function compareEvents(left: LunaEvent, right: LunaEvent): number {
  const timestamp = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  if (timestamp !== 0) return timestamp;
  return left.id.localeCompare(right.id);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAXIMUM_TIMEOUT_MS = 2_147_483_647;

function scheduleTimeout(callback: () => void, milliseconds: number): ScheduledTimeout {
  let cancelled = false;
  let remaining = milliseconds;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    const chunk = Math.min(remaining, MAXIMUM_TIMEOUT_MS);
    timer = setTimeout(() => {
      remaining -= chunk;
      if (cancelled) return;
      if (remaining > 0) schedule();
      else callback();
    }, chunk);
  };
  schedule();
  return {
    cancel() {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
