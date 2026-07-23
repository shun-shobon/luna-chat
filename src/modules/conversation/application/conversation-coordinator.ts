import type {
  AgentRuntimePort,
  AgentTurnResult,
  StartedAgentTurn,
} from "../../agent/ports/outbound/agent-runtime-port";
import {
  conversationScopeKey,
  type ConversationScope,
} from "../../discord/domain/conversation-scope";
import type { DiscordMessage } from "../../discord/domain/discord-message";
import type {
  DiscordActionBatchPort,
  DiscordActionResult,
} from "../../discord/ports/discord-action-batch-port";
import type { ConversationHistoryPort } from "../ports/conversation-history-port";

export type ConversationThreadInput = Readonly<{
  actionOwnerId: string;
  baseInstructions: string;
  config: Record<string, unknown>;
  cwd: string;
  developerInstructions: string;
}>;

type ConversationCoordinatorOptions = Readonly<{
  debounceMs: number;
  initialHistoryLimit: number;
  sessionIdleMs: number;
  typingIdleMs: number;
}>;

type AcceptedConversationMessage = Readonly<{
  message: DiscordMessage;
  scope: ConversationScope;
}>;

type ConversationErrorHandler = (
  error: unknown,
  context: Readonly<{ scope: ConversationScope; operation: string }>,
) => void;

type ConversationEventHandler = (
  event: string,
  context: Readonly<{
    actionIndex?: number | undefined;
    scope: ConversationScope;
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
      actions: DiscordActionBatchPort;
      agent: AgentRuntimePort;
      createThreadInput: () => Promise<ConversationThreadInput>;
      history: ConversationHistoryPort;
      onError: ConversationErrorHandler;
      onEvent: ConversationEventHandler;
    }>,
    private readonly options: ConversationCoordinatorOptions,
  ) {}

  accept(input: AcceptedConversationMessage): void {
    if (!this.#accepting) return;
    const key = conversationScopeKey(input.scope);
    let actor = this.#actors.get(key);
    if (actor === undefined) {
      actor = new ConversationActor(input.scope, this.dependencies, this.options, () => {
        this.#actors.delete(key);
      });
      this.#actors.set(key, actor);
    }
    actor.accept(input.message);
  }

  typing(scope: ConversationScope, userId: string): void {
    if (!this.#accepting) return;
    const key = conversationScopeKey(scope);
    let actor = this.#actors.get(key);
    if (actor === undefined) {
      actor = new ConversationActor(scope, this.dependencies, this.options, () => {
        this.#actors.delete(key);
      });
      this.#actors.set(key, actor);
    }
    actor.typing(userId);
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

  hasSession(scope: ConversationScope): boolean {
    return this.#actors.get(conversationScopeKey(scope))?.hasSession ?? false;
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
  | "actions"
  | "orphaned_actions"
  | "idle"
  | "archiving"
  | "closed";

type Command =
  | Readonly<{ kind: "accept"; message: DiscordMessage }>
  | Readonly<{ kind: "typing"; userId: string }>
  | Readonly<{ kind: "typing_idle"; userId: string; token: number }>
  | Readonly<{ kind: "debounce"; token: number }>
  | Readonly<{ kind: "idle"; token: number }>
  | Readonly<{
      kind: "thread_ready";
      token: number;
      threadId: string;
      actionOwnerId: string;
      history: readonly DiscordMessage[];
      batch: readonly DiscordMessage[];
    }>
  | Readonly<{ kind: "operation_failed"; token: number; operation: string; error: unknown }>
  | Readonly<{ kind: "turn_started"; token: number; turn: StartedAgentTurn }>
  | Readonly<{ kind: "turn_finished"; token: number; result: AgentTurnResult }>
  | Readonly<{ kind: "steer_finished"; token: number; message: DiscordMessage; error?: unknown }>
  | Readonly<{ kind: "actions_finished"; token: number; results: readonly DiscordActionResult[] }>
  | Readonly<{ kind: "archive_finished"; token: number; error?: unknown }>
  | Readonly<{ kind: "shutdown"; resolve: () => void }>
  | Readonly<{ kind: "abort"; resolve: () => void }>
  | Readonly<{ kind: "connection_lost"; error: unknown }>;

class ConversationActor {
  #phase: Phase = "collecting";
  #mailbox = Promise.resolve();
  #openingBatch: DiscordMessage[] = [];
  #queue: DiscordMessage[] = [];
  #steerQueue: DiscordMessage[] = [];
  #steerActive: DiscordMessage | undefined;
  #actionOwnerId: string | undefined;
  #threadId: string | undefined;
  #turnId: string | undefined;
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
    private readonly scope: ConversationScope,
    private readonly dependencies: Readonly<{
      actions: DiscordActionBatchPort;
      agent: AgentRuntimePort;
      createThreadInput: () => Promise<ConversationThreadInput>;
      history: ConversationHistoryPort;
      onError: ConversationErrorHandler;
      onEvent: ConversationEventHandler;
    }>,
    private readonly options: ConversationCoordinatorOptions,
    private readonly onClosed: () => void,
  ) {}

  accept(message: DiscordMessage): void {
    this.#sessionStarted = true;
    this.#post({ kind: "accept", message });
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
        this.dependencies.onError(error, { scope: this.scope, operation: "actor/mailbox" });
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
        this.#handleAccept(command.message);
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
        if (this.#phase === "idle") this.#archive();
        else this.#closeRequested = true;
        return;
      case "thread_ready":
        if (!this.#matches(command.token, "opening")) return;
        this.#openingBatch = [];
        this.#threadId = command.threadId;
        this.#actionOwnerId = command.actionOwnerId;
        this.dependencies.onEvent(
          "conversation.thread_opened",
          { scope: this.scope, threadId: command.threadId },
          { historyCount: command.history.length, messageCount: command.batch.length },
        );
        this.#startTurn(
          JSON.stringify({
            source: "discord",
            scope: this.scope,
            history: command.history,
            messages: command.batch,
          }),
        );
        return;
      case "operation_failed":
        if (command.token !== this.#operationToken) return;
        this.dependencies.onError(command.error, {
          scope: this.scope,
          operation: command.operation,
        });
        this.#archive();
        return;
      case "turn_started":
        if (!this.#matches(command.token, "starting")) return;
        this.#phase = "turn";
        this.#turnId = command.turn.turnId;
        this.dependencies.onEvent("conversation.turn_started", {
          scope: this.scope,
          threadId: this.#threadId,
          turnId: command.turn.turnId,
        });
        this.#steerQueue.push(...this.#queue);
        this.#queue = [];
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
          { scope: this.scope, threadId: this.#threadId, turnId: this.#turnId },
          { status: command.result.status },
          command.result,
        );
        this.#finishTurnAfterSteering();
        return;
      case "steer_finished":
        if (command.token !== this.#operationToken) return;
        this.#steerActive = undefined;
        if (command.error !== undefined) {
          this.dependencies.onError(command.error, { scope: this.scope, operation: "turn/steer" });
          this.#queue.push(command.message);
        }
        this.#kickSteer();
        this.#finishTurnAfterSteering();
        return;
      case "actions_finished":
        if (command.token !== this.#operationToken) return;
        this.#handleActionResults(command.results);
        return;
      case "archive_finished":
        if (!this.#matches(command.token, "archiving")) return;
        if (command.error !== undefined) {
          this.dependencies.onError(command.error, {
            scope: this.scope,
            operation: "thread/archive",
          });
        }
        this.#threadId = undefined;
        this.#actionOwnerId = undefined;
        this.#turnId = undefined;
        this.dependencies.onEvent(
          "conversation.thread_archived",
          { scope: this.scope },
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
        if (this.#phase === "idle") this.#archive();
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
        const ownerId = this.#actionOwnerId;
        this.#threadId = undefined;
        if (this.#phase === "actions" || this.#phase === "orphaned_actions") {
          this.#phase = "orphaned_actions";
        } else {
          this.#actionOwnerId = undefined;
          if (ownerId !== undefined) void this.#releaseTyping(ownerId);
          this.#operationToken += 1;
          this.#close();
        }
        return;
      case "connection_lost":
        this.#handleConnectionLost(command.error);
    }
  }

  #handleAccept(message: DiscordMessage): void {
    this.#closeRequested = false;
    this.#resetIdleTimer();
    if (this.#phase === "turn") {
      this.#steerQueue.push(message);
      this.#kickSteer();
      return;
    }
    this.#queue.push(message);
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
    const batch = this.#queue.splice(0).sort(compareMessages);
    const token = ++this.#operationToken;
    if (this.#threadId !== undefined) {
      this.#startTurn(
        JSON.stringify({ source: "discord", scope: this.scope, history: [], messages: batch }),
      );
      return;
    }

    this.#phase = "opening";
    this.#openingBatch = [...batch];
    const beforeMessageId = batch[0]?.id;
    if (beforeMessageId === undefined) throw new Error("Conversation batch must not be empty");
    void Promise.all([
      this.dependencies.history
        .fetchBefore(this.scope, beforeMessageId, this.options.initialHistoryLimit)
        .catch((error: unknown) => {
          this.dependencies.onError(error, { scope: this.scope, operation: "history/fetch" });
          return [];
        }),
      this.dependencies.createThreadInput(),
    ])
      .then(async ([history, input]) => {
        if (!this.#matches(token, "opening")) return;
        const threadId = await this.dependencies.agent.openThread(input);
        const batchIds = new Set(batch.map((message) => message.id));
        const deduplicatedHistory = history
          .filter((message) => !batchIds.has(message.id))
          .sort(compareMessages);
        this.#post({
          kind: "thread_ready",
          token,
          threadId,
          actionOwnerId: input.actionOwnerId,
          history: deduplicatedHistory,
          batch,
        });
      })
      .catch((error: unknown) =>
        this.#post({ kind: "operation_failed", token, operation: "thread/open", error }),
      );
  }

  #startTurn(input: string): void {
    const threadId = this.#threadId;
    if (threadId === undefined) throw new Error("Cannot start a turn without a thread");
    const token = ++this.#operationToken;
    this.#phase = "starting";
    void this.dependencies.agent.startTurn(threadId, input).then(
      (turn) => this.#post({ kind: "turn_started", token, turn }),
      (error: unknown) =>
        this.#post({ kind: "operation_failed", token, operation: "turn/start", error }),
    );
  }

  #kickSteer(): void {
    if (this.#phase !== "turn" || this.#steerActive !== undefined) return;
    const message = this.#steerQueue.shift();
    if (message === undefined) return;
    const threadId = this.#threadId;
    const turnId = this.#turnId;
    if (threadId === undefined || turnId === undefined)
      throw new Error("Active turn IDs are missing");
    const token = this.#operationToken;
    this.#steerActive = message;
    void this.dependencies.agent
      .steerTurn(
        threadId,
        turnId,
        JSON.stringify({ source: "discord", scope: this.scope, history: [], messages: [message] }),
      )
      .then(
        () => this.#post({ kind: "steer_finished", token, message }),
        (error: unknown) => this.#post({ kind: "steer_finished", token, message, error }),
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
    const ownerId = this.#actionOwnerId;
    const turnId = this.#turnId;
    this.#turnId = undefined;
    if (result.status !== "completed" || ownerId === undefined) {
      if (result.status !== "completed") {
        this.dependencies.onError(
          new Error(result.errorMessage ?? `Agent turn ended with status: ${result.status}`),
          { scope: this.scope, operation: "turn/completion" },
        );
      }
      this.#archive();
      return;
    }
    const token = this.#operationToken;
    this.#phase = "actions";
    this.dependencies.onEvent(
      "conversation.actions_started",
      { scope: this.scope, threadId: this.#threadId, turnId },
      { actionCount: result.output.actions.length },
      result.output.actions,
    );
    void (async () => {
      try {
        const results = await this.dependencies.actions.execute(result.output.actions, ownerId);
        await this.#releaseTyping(ownerId);
        this.#post({ kind: "actions_finished", token, results });
      } catch (error: unknown) {
        await this.#releaseTyping(ownerId);
        this.#post({ kind: "operation_failed", token, operation: "actions/execute", error });
      }
    })();
  }

  #handleActionResults(results: readonly DiscordActionResult[]): void {
    for (const result of results) {
      this.dependencies.onEvent(
        "conversation.action_settled",
        { actionIndex: result.index, scope: this.scope, threadId: this.#threadId },
        { actionKind: result.actionKind, success: result.success, target: result.target },
      );
    }
    this.dependencies.onEvent(
      "conversation.actions_settled",
      { scope: this.scope, threadId: this.#threadId },
      {
        actionCount: results.length,
        failureCount: results.filter((result) => !result.success).length,
      },
      results,
    );
    if (this.#phase === "orphaned_actions") {
      this.#threadId = undefined;
      this.#actionOwnerId = undefined;
      if (this.#queue.length > 0) this.#beginCollecting(true);
      else this.#close();
      return;
    }
    if (this.#phase !== "actions") return;
    if (results.some((result) => !result.success)) {
      this.#startTurn(JSON.stringify({ source: "discord_action_results", results }));
      return;
    }
    this.#resetIdleTimer();
    if (this.#closeRequested) this.#archive();
    else if (this.#queue.length > 0) this.#beginCollecting(true);
    else this.#phase = "idle";
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
    const ownerId = this.#actionOwnerId;
    void (async () => {
      if (ownerId !== undefined) await this.#releaseTyping(ownerId);
      await this.dependencies.agent.archiveThread(threadId);
    })().then(
      () => this.#post({ kind: "archive_finished", token }),
      (error: unknown) => this.#post({ kind: "archive_finished", token, error }),
    );
  }

  #handleConnectionLost(error: unknown): void {
    this.dependencies.onError(error, { scope: this.scope, operation: "agent/connection" });
    if (this.#phase === "actions") {
      this.#phase = "orphaned_actions";
      this.#threadId = undefined;
      return;
    }
    if (this.#phase === "opening") this.#queue.push(...this.#openingBatch);
    this.#openingBatch = [];
    this.#queue.push(...this.#steerQueue);
    this.#steerActive = undefined;
    this.#steerQueue = [];
    const ownerId = this.#actionOwnerId;
    this.#threadId = undefined;
    this.#actionOwnerId = undefined;
    this.#turnId = undefined;
    this.#operationToken += 1;
    if (ownerId !== undefined) void this.#releaseTyping(ownerId);
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

  async #releaseTyping(ownerId: string): Promise<void> {
    try {
      await this.dependencies.actions.releaseTyping(ownerId);
    } catch (error: unknown) {
      this.dependencies.onError(error, { scope: this.scope, operation: "typing/release" });
    }
  }
}

function compareMessages(left: DiscordMessage, right: DiscordMessage): number {
  const timestamp = left.timestamp.localeCompare(right.timestamp);
  if (timestamp !== 0) return timestamp;
  return BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0;
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
