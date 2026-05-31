import type {
  AiService,
  DiscordPromptContext,
  NonEmptyRuntimeMessages,
} from "../../ai/ports/inbound/ai-service-port";
import type { TypingLifecycleRegistry } from "../../typing/typing-lifecycle-registry";
import type { RuntimeMessage } from "../domain/runtime-message";

type TimeoutHandle = ReturnType<typeof setTimeout>;

type LoggerLike = {
  warn: (...arguments_: unknown[]) => void;
  error: (...arguments_: unknown[]) => void;
};

export type DiscordMessageDispatchInput = {
  context: DiscordPromptContext;
  currentMessage: RuntimeMessage;
  loadRecentMessages: () => Promise<RuntimeMessage[]>;
  sendTyping?: (() => Promise<unknown>) | undefined;
};

export type DiscordAiDispatcher = {
  enqueue: (input: DiscordMessageDispatchInput) => void;
  recordTypingStart: (input: RecordTypingStartInput) => void;
  dispose: () => void;
};

type RecordTypingStartInput = {
  scopeKey: string;
  userId: string;
};

type CreateDiscordAiDispatcherInput = {
  aiService: Pick<AiService, "generateReply">;
  dispatchDelayMs: number;
  logger: LoggerLike;
  typingIdleTimeoutMs: number;
  typingLifecycleRegistry: TypingLifecycleRegistry;
  clearTimeoutFn?: ((handle: TimeoutHandle) => void) | undefined;
  now?: (() => number) | undefined;
  setTimeoutFn?: ((handler: () => void, timeoutMs: number) => TimeoutHandle) | undefined;
};

type PendingDispatchScope = {
  inputs: DiscordMessageDispatchInput[];
  timer: TimeoutHandle | undefined;
};

const NOOP_STOP = (): void => undefined;

export function createDiscordAiDispatcher(
  input: CreateDiscordAiDispatcherInput,
): DiscordAiDispatcher {
  const now = input.now ?? (() => Date.now());
  const setTimeoutFn = input.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout;
  const pendingScopes = new Map<string, PendingDispatchScope>();
  const activeTypingByScope = new Map<string, Map<string, number>>();

  const getPendingScope = (scopeKey: string): PendingDispatchScope => {
    const existing = pendingScopes.get(scopeKey);
    if (existing) {
      return existing;
    }

    const created: PendingDispatchScope = {
      inputs: [],
      timer: undefined,
    };
    pendingScopes.set(scopeKey, created);
    return created;
  };

  const clearScopeTimer = (scope: PendingDispatchScope): void => {
    if (!scope.timer) {
      return;
    }

    clearTimeoutFn(scope.timer);
    scope.timer = undefined;
  };

  const scheduleScope = (scopeKey: string, timeoutMs: number): void => {
    const scope = getPendingScope(scopeKey);
    clearScopeTimer(scope);
    scope.timer = setTimeoutFn(
      () => {
        scope.timer = undefined;
        void flushScope(scopeKey);
      },
      Math.max(0, timeoutMs),
    );
  };

  const pruneExpiredTyping = (scopeKey: string): void => {
    const activeTyping = activeTypingByScope.get(scopeKey);
    if (!activeTyping) {
      return;
    }

    const nowMs = now();
    for (const [userId, expiresAt] of activeTyping.entries()) {
      if (expiresAt <= nowMs) {
        activeTyping.delete(userId);
      }
    }

    if (activeTyping.size === 0) {
      activeTypingByScope.delete(scopeKey);
    }
  };

  const getEarliestTypingExpiration = (scopeKey: string): number | undefined => {
    pruneExpiredTyping(scopeKey);

    const activeTyping = activeTypingByScope.get(scopeKey);
    if (!activeTyping) {
      return undefined;
    }

    let earliest: number | undefined;
    for (const expiresAt of activeTyping.values()) {
      if (earliest === undefined || expiresAt < earliest) {
        earliest = expiresAt;
      }
    }

    return earliest;
  };

  const clearUserTyping = (scopeKey: string, userId: string): void => {
    const activeTyping = activeTypingByScope.get(scopeKey);
    if (!activeTyping) {
      return;
    }

    activeTyping.delete(userId);
    if (activeTyping.size === 0) {
      activeTypingByScope.delete(scopeKey);
    }
  };

  const flushScope = async (scopeKey: string): Promise<void> => {
    const scope = pendingScopes.get(scopeKey);
    if (!scope || scope.inputs.length === 0) {
      pendingScopes.delete(scopeKey);
      return;
    }

    const typingExpiration = getEarliestTypingExpiration(scopeKey);
    if (typingExpiration !== undefined) {
      scheduleScope(scopeKey, typingExpiration - now());
      return;
    }

    const batch = scope.inputs;
    scope.inputs = [];
    clearScopeTimer(scope);

    const firstInput = batch[0];
    if (!firstInput) {
      return;
    }

    const currentMessages = toNonEmptyRuntimeMessages(
      batch.map((dispatchInput) => dispatchInput.currentMessage),
    );
    if (!currentMessages) {
      return;
    }

    const stopTypingLoop = startMentionTypingLoop(input, batch);
    try {
      await input.aiService.generateReply({
        context: firstInput.context,
        currentMessages,
        loadRecentMessages: firstInput.loadRecentMessages,
      });
    } catch (error: unknown) {
      input.logger.error("Failed to generate AI reply:", error);
    } finally {
      stopTypingLoop();
    }

    if (scope.inputs.length === 0) {
      pendingScopes.delete(scopeKey);
    }
  };

  return {
    enqueue: (dispatchInput) => {
      const scopeKey = resolveDiscordDispatchScopeKey({
        context: dispatchInput.context,
        message: dispatchInput.currentMessage,
      });
      clearUserTyping(scopeKey, dispatchInput.currentMessage.authorId);

      const scope = getPendingScope(scopeKey);
      scope.inputs.push(dispatchInput);
      scheduleScope(scopeKey, input.dispatchDelayMs);
    },
    recordTypingStart: (typingInput) => {
      const activeTyping =
        activeTypingByScope.get(typingInput.scopeKey) ?? new Map<string, number>();
      activeTyping.set(typingInput.userId, now() + input.typingIdleTimeoutMs);
      activeTypingByScope.set(typingInput.scopeKey, activeTyping);
    },
    dispose: () => {
      for (const scope of pendingScopes.values()) {
        clearScopeTimer(scope);
      }
      pendingScopes.clear();
      activeTypingByScope.clear();
    },
  };
}

export function resolveDiscordChannelScopeKey(channelId: string): string {
  return `channel:${channelId}`;
}

export function resolveDiscordDmScopeKey(userId: string): string {
  return `dm-user:${userId}`;
}

function resolveDiscordDispatchScopeKey(input: {
  context: DiscordPromptContext;
  message: Pick<RuntimeMessage, "authorId" | "channelId">;
}): string {
  if (input.context.kind === "dm") {
    return resolveDiscordDmScopeKey(input.message.authorId);
  }

  return resolveDiscordChannelScopeKey(input.message.channelId);
}

function startMentionTypingLoop(
  input: CreateDiscordAiDispatcherInput,
  batch: DiscordMessageDispatchInput[],
): () => void {
  const typingInput = batch.find((dispatchInput) => {
    return dispatchInput.currentMessage.mentionedBot && dispatchInput.sendTyping;
  });
  const sendTyping = typingInput?.sendTyping;
  if (!typingInput || !sendTyping) {
    return NOOP_STOP;
  }

  return input.typingLifecycleRegistry.start({
    channelId: typingInput.currentMessage.channelId,
    onTypingError: (error) => {
      input.logger.warn("Failed to send typing indicator:", error);
    },
    sendTyping,
    source: `message-batch:${batch
      .map((dispatchInput) => dispatchInput.currentMessage.id)
      .join(",")}`,
  }).stop;
}

function toNonEmptyRuntimeMessages(
  messages: RuntimeMessage[],
): NonEmptyRuntimeMessages | undefined {
  const firstMessage = messages[0];
  if (!firstMessage) {
    return undefined;
  }

  return [firstMessage, ...messages.slice(1)];
}
