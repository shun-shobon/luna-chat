import { logger } from "../../../shared/logger";
import type { TurnResult } from "../domain/turn-result";
import type { AiInput, AiService, HeartbeatInput } from "../ports/inbound/ai-service-port";
import type { AiRuntimePort, StartedTurn, TurnObserver } from "../ports/outbound/ai-runtime-port";

import {
  buildHeartbeatPromptBundle,
  buildThreadPromptBundle,
  buildUserRolePrompt,
} from "./prompt-composer";
import { buildThreadConfig } from "./thread-config-factory";

type TimeoutHandle = ReturnType<typeof setTimeout>;
type DiscordSessionKey = string;

type ChannelSessionCoordinatorOptions = {
  createRuntime: () => AiRuntimePort;
  discordMcpServerUrl: string;
  onDiscordTurnCompleted?: (channelIds: string[]) => void | Promise<void>;
  botUserId: string;
  workspaceDir: string;
  codexHomeDir: string;
  discordTurnTimeoutMs: number;
  heartbeatTurnTimeoutMs: number;
  sessionIdleMs?: number;
  now?: () => number;
  setTimeoutFn?: (handler: () => void, timeoutMs: number) => TimeoutHandle;
  clearTimeoutFn?: (handle: TimeoutHandle) => void;
};

type TurnLogContext =
  | {
      source: "discord";
      channelId: string;
      messageId: string;
    }
  | {
      source: "heartbeat";
    }
  | {
      source: "cron";
    };

type DiscordSession = {
  key: DiscordSessionKey;
  threadId: string;
  opChain: Promise<void>;
  injectedHistoryScopes: Set<string>;
  activeTurnId: string | undefined;
  activeTurnChannelIds: Set<string>;
  turnCompletion: Promise<void> | undefined;
  closeAfterTurn: boolean;
  lastMessageAt: number;
  idleTimer: TimeoutHandle | undefined;
};

const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;

class TurnFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnFailedError";
  }
}

export class ChannelSessionCoordinator implements AiService {
  private readonly sessionIdleMs: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: (handler: () => void, timeoutMs: number) => TimeoutHandle;
  private readonly clearTimeoutFn: (handle: TimeoutHandle) => void;

  private runtime: AiRuntimePort | undefined;
  private runtimeInitialization: Promise<AiRuntimePort> | undefined;
  private runtimeInitialized = false;
  private readonly discordSessions = new Map<DiscordSessionKey, DiscordSession>();
  private readonly discordSessionInitializations = new Map<
    DiscordSessionKey,
    Promise<DiscordSession>
  >();

  constructor(private readonly options: ChannelSessionCoordinatorOptions) {
    this.sessionIdleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  async initializeRuntime(): Promise<void> {
    await this.ensureRuntime();
  }

  async close(): Promise<void> {
    this.disposeAllDiscordSessions();
    await this.resetRuntime();
  }

  async generateReply(input: AiInput): Promise<void> {
    try {
      const sessionKey = resolveDiscordSessionKey(input);
      const session = await this.ensureDiscordSession(sessionKey);
      this.touchDiscordSession(session);

      const result = await this.enqueueSessionOperation(session, async () => {
        return await this.handleDiscordMessage(session, input);
      });

      if (result.awaitCompletion) {
        await result.awaitCompletion;
      }
    } catch (error: unknown) {
      if (!(error instanceof TurnFailedError)) {
        await this.resetRuntimeAndSession();
      }
      throw error;
    }
  }

  async generateHeartbeat(input: HeartbeatInput): Promise<void> {
    const context: TurnLogContext = {
      source: input.source ?? "heartbeat",
    };

    try {
      const runtime = await this.ensureRuntime();
      const promptBundle = await buildHeartbeatPromptBundle(
        this.options.workspaceDir,
        input.prompt,
        this.options.botUserId,
      );
      const threadId = await runtime.startThread({
        config: buildThreadConfig(
          this.options.discordMcpServerUrl,
          this.options.workspaceDir,
          this.options.codexHomeDir,
        ),
        developerRolePrompt: promptBundle.developerRolePrompt,
        instructions: promptBundle.instructions,
      });

      const startedTurn = await runtime.startTurn(
        threadId,
        promptBundle.userRolePrompt,
        createTurnObserver(context),
        {
          timeoutMs: this.options.heartbeatTurnTimeoutMs,
        },
      );
      logTurnStarted(context, threadId, startedTurn.turnId);

      const turnResult = await startedTurn.completion;
      logTurnResult(context, threadId, startedTurn.turnId, turnResult);
      this.runOnDiscordTurnCompleted(extractTypingChannelIds(turnResult));
      throwIfTurnFailed(turnResult);
    } catch (error: unknown) {
      if (!(error instanceof TurnFailedError)) {
        await this.resetRuntimeAndSession();
      }
      throw error;
    }
  }

  private async handleDiscordMessage(
    session: DiscordSession,
    input: AiInput,
  ): Promise<{
    awaitCompletion?: Promise<void>;
  }> {
    if (this.discordSessions.get(session.key) !== session) {
      return {};
    }

    const runtime = await this.ensureRuntime();
    const historyScope = resolveInitialHistoryScope(input);
    const includeRecentMessages = !session.injectedHistoryScopes.has(historyScope);
    const recentMessages = includeRecentMessages ? await input.loadRecentMessages() : [];

    if (includeRecentMessages) {
      session.injectedHistoryScopes.add(historyScope);
    }

    const threadId = session.threadId;

    if (session.activeTurnId) {
      const expectedTurnId = session.activeTurnId;
      const userRolePrompt = buildUserRolePrompt({
        context: input.context,
        currentMessage: input.currentMessage,
        recentMessages,
      });
      session.activeTurnChannelIds.add(input.currentMessage.channelId);

      try {
        await runtime.steerTurn(threadId, expectedTurnId, userRolePrompt);
        return {};
      } catch {
        session.activeTurnChannelIds.delete(input.currentMessage.channelId);
        await runtime.interruptTurn(threadId, expectedTurnId).catch(() => undefined);

        await this.startDiscordTurn(session, runtime, {
          channelId: input.currentMessage.channelId,
          messageId: input.currentMessage.id,
          prompt: userRolePrompt,
        });

        return session.turnCompletion ? { awaitCompletion: session.turnCompletion } : {};
      }
    }

    const userRolePrompt = buildUserRolePrompt({
      context: input.context,
      currentMessage: input.currentMessage,
      recentMessages,
    });

    await this.startDiscordTurn(session, runtime, {
      channelId: input.currentMessage.channelId,
      messageId: input.currentMessage.id,
      prompt: userRolePrompt,
    });

    return session.turnCompletion ? { awaitCompletion: session.turnCompletion } : {};
  }

  private async ensureDiscordSession(key: DiscordSessionKey): Promise<DiscordSession> {
    const existing = this.discordSessions.get(key);
    if (existing) {
      return existing;
    }

    const initializing = this.discordSessionInitializations.get(key);
    if (initializing) {
      return await initializing;
    }

    const initialization = this.createDiscordSession(key).finally(() => {
      if (this.discordSessionInitializations.get(key) === initialization) {
        this.discordSessionInitializations.delete(key);
      }
    });
    this.discordSessionInitializations.set(key, initialization);
    return await initialization;
  }

  private async createDiscordSession(key: DiscordSessionKey): Promise<DiscordSession> {
    const runtime = await this.ensureRuntime();
    const threadPromptBundle = await buildThreadPromptBundle(
      this.options.workspaceDir,
      this.options.botUserId,
    );
    const threadId = await runtime.startThread({
      config: buildThreadConfig(
        this.options.discordMcpServerUrl,
        this.options.workspaceDir,
        this.options.codexHomeDir,
      ),
      developerRolePrompt: threadPromptBundle.developerRolePrompt,
      instructions: threadPromptBundle.instructions,
    });

    const session: DiscordSession = {
      key,
      threadId,
      opChain: Promise.resolve(),
      injectedHistoryScopes: new Set(),
      activeTurnId: undefined,
      activeTurnChannelIds: new Set(),
      turnCompletion: undefined,
      closeAfterTurn: false,
      lastMessageAt: this.now(),
      idleTimer: undefined,
    };
    this.discordSessions.set(key, session);
    this.scheduleSessionIdleTimer(session);

    return session;
  }

  private touchDiscordSession(session: DiscordSession): void {
    session.lastMessageAt = this.now();
    session.closeAfterTurn = false;
    this.scheduleSessionIdleTimer(session);
  }

  private scheduleSessionIdleTimer(session: DiscordSession): void {
    if (session.idleTimer) {
      this.clearTimeoutFn(session.idleTimer);
    }

    session.idleTimer = this.setTimeoutFn(() => {
      void this.handleSessionIdleTimeout(session);
    }, this.sessionIdleMs);
  }

  private async handleSessionIdleTimeout(session: DiscordSession): Promise<void> {
    await this.enqueueSessionOperation(session, async () => {
      if (this.discordSessions.get(session.key) !== session) {
        return;
      }

      if (!this.isSessionIdleExpired(session)) {
        this.scheduleSessionIdleTimer(session);
        return;
      }

      if (session.activeTurnId) {
        session.closeAfterTurn = true;
        return;
      }

      this.disposeDiscordSession(session);
    });
  }

  private isSessionIdleExpired(session: DiscordSession): boolean {
    return this.now() - session.lastMessageAt >= this.sessionIdleMs;
  }

  private async startDiscordTurn(
    session: DiscordSession,
    runtime: AiRuntimePort,
    input: {
      channelId: string;
      messageId: string;
      prompt: string;
    },
  ): Promise<void> {
    const context: TurnLogContext = {
      source: "discord",
      channelId: input.channelId,
      messageId: input.messageId,
    };

    const startedTurn = await runtime.startTurn(
      session.threadId,
      input.prompt,
      createTurnObserver(context),
      {
        timeoutMs: this.options.discordTurnTimeoutMs,
      },
    );
    session.activeTurnId = startedTurn.turnId;
    session.activeTurnChannelIds = new Set([input.channelId]);

    logTurnStarted(context, session.threadId, startedTurn.turnId);

    const turnCompletion = this.trackDiscordTurnCompletion(session, startedTurn, {
      context,
      threadId: session.threadId,
      turnId: startedTurn.turnId,
    });
    turnCompletion.catch((error: unknown) => {
      logger.warn("Discord turn failed:", error);
    });
    session.turnCompletion = turnCompletion;
  }

  private trackDiscordTurnCompletion(
    session: DiscordSession,
    startedTurn: StartedTurn,
    meta: {
      context: TurnLogContext;
      threadId: string;
      turnId: string;
    },
  ): Promise<void> {
    let shouldDisposeSession = false;
    let completedTypingChannelIds: string[] = [];

    return startedTurn.completion
      .then((turnResult) => {
        logTurnResult(meta.context, meta.threadId, meta.turnId, turnResult);
        completedTypingChannelIds = extractTypingChannelIds(turnResult);

        if (turnResult.status !== "completed") {
          shouldDisposeSession = true;
          throwIfTurnFailed(turnResult);
        }
      })
      .finally(() => {
        if (this.discordSessions.get(session.key) !== session) {
          return;
        }
        if (session.activeTurnId !== meta.turnId) {
          return;
        }

        const completedChannels = new Set(session.activeTurnChannelIds);
        session.activeTurnId = undefined;
        session.turnCompletion = undefined;
        session.activeTurnChannelIds.clear();

        for (const channelId of completedTypingChannelIds) {
          completedChannels.add(channelId);
        }

        this.runOnDiscordTurnCompleted(Array.from(completedChannels));

        if (shouldDisposeSession || session.closeAfterTurn || this.isSessionIdleExpired(session)) {
          this.disposeDiscordSession(session);
        }
      });
  }

  private runOnDiscordTurnCompleted(channelIds: string[]): void {
    const callback = this.options.onDiscordTurnCompleted;
    if (!callback || channelIds.length === 0) {
      return;
    }

    void Promise.resolve(callback(channelIds)).catch((error: unknown) => {
      logger.warn("Failed to run onDiscordTurnCompleted callback:", error);
    });
  }

  private async ensureRuntime(): Promise<AiRuntimePort> {
    if (this.runtime && this.runtimeInitialized) {
      return this.runtime;
    }

    if (this.runtimeInitialization) {
      return await this.runtimeInitialization;
    }

    if (!this.runtime) {
      this.runtime = this.options.createRuntime();
    }
    const runtime = this.runtime;

    const initialization = runtime
      .initialize()
      .then(() => {
        this.runtimeInitialized = true;
        return runtime;
      })
      .catch((error) => {
        if (this.runtime === runtime) {
          this.runtime = undefined;
        }
        this.runtimeInitialized = false;
        throw error;
      })
      .finally(() => {
        if (this.runtimeInitialization === initialization) {
          this.runtimeInitialization = undefined;
        }
      });

    this.runtimeInitialization = initialization;
    return await initialization;
  }

  private async resetRuntimeAndSession(): Promise<void> {
    this.disposeAllDiscordSessions();
    await this.resetRuntime();
  }

  private async resetRuntime(): Promise<void> {
    this.runtimeInitialization = undefined;
    this.runtimeInitialized = false;
    const runtime = this.runtime;
    this.runtime = undefined;
    if (!runtime) {
      return;
    }

    await runtime.close().catch((error: unknown) => {
      logger.warn("Failed to close runtime:", error);
    });
  }

  private disposeAllDiscordSessions(): void {
    const sessions = Array.from(this.discordSessions.values());
    for (const session of sessions) {
      this.disposeDiscordSession(session);
    }
    this.discordSessionInitializations.clear();
  }

  private disposeDiscordSession(session: DiscordSession): void {
    if (session.idleTimer) {
      this.clearTimeoutFn(session.idleTimer);
      session.idleTimer = undefined;
    }

    session.activeTurnId = undefined;
    session.turnCompletion = undefined;
    session.activeTurnChannelIds.clear();
    session.closeAfterTurn = false;

    if (this.discordSessions.get(session.key) === session) {
      this.discordSessions.delete(session.key);
    }
  }

  private async enqueueSessionOperation<T>(
    session: DiscordSession,
    operation: () => Promise<T>,
  ): Promise<T> {
    const chained = session.opChain.then(operation, operation);
    session.opChain = chained.then(
      () => undefined,
      () => undefined,
    );

    return await chained;
  }
}

function extractTypingChannelIds(turnResult: TurnResult): string[] {
  const channelIds = new Set<string>();

  for (const toolCall of turnResult.mcpToolCalls) {
    if (toolCall.server !== "discord" || toolCall.tool !== "start_typing") {
      continue;
    }

    const channelId = extractChannelIdFromToolResult(toolCall.result);
    if (channelId) {
      channelIds.add(channelId);
    }
  }

  return Array.from(channelIds);
}

function extractChannelIdFromToolResult(result: unknown): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const structuredContent = result["structuredContent"];
  if (!isRecord(structuredContent)) {
    return undefined;
  }

  const channelId = structuredContent["channelId"];
  return typeof channelId === "string" && channelId.length > 0 ? channelId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function throwIfTurnFailed(turnResult: TurnResult): void {
  if (turnResult.status === "completed") {
    return;
  }

  const errorMessage = turnResult.errorMessage ?? `app-server turn status is ${turnResult.status}`;
  throw new TurnFailedError(errorMessage);
}

function resolveDiscordSessionKey(input: AiInput): DiscordSessionKey {
  if (input.context.kind === "dm") {
    return `dm-user:${input.currentMessage.authorId}`;
  }

  return `channel:${input.currentMessage.channelId}`;
}

function resolveInitialHistoryScope(input: AiInput): string {
  if (input.context.kind === "dm") {
    return `dm-user:${input.currentMessage.authorId}`;
  }

  return `channel:${input.currentMessage.channelId}`;
}

function createTurnObserver(context: TurnLogContext): TurnObserver {
  return {
    onMcpToolCallStarted: (event) => {
      logger.info("ai.turn.mcp_tool_call.started", {
        ...toTurnLogContextFields(context),
        server: event.server,
        threadId: event.threadId,
        tool: event.tool,
        turnId: event.turnId,
      });
    },
    onMcpToolCallCompleted: (event) => {
      logger.info("ai.turn.mcp_tool_call.completed", {
        ...toTurnLogContextFields(context),
        server: event.server,
        status: event.status,
        threadId: event.threadId,
        tool: event.tool,
        turnId: event.turnId,
      });
    },
  };
}

function logTurnStarted(context: TurnLogContext, threadId: string, turnId: string): void {
  logger.info("ai.turn.started", {
    ...toTurnLogContextFields(context),
    threadId,
    turnId,
  });
}

function logTurnResult(
  context: TurnLogContext,
  threadId: string,
  turnId: string,
  turnResult: TurnResult,
): void {
  logger.info("ai.turn.completed", {
    ...toTurnLogContextFields(context),
    errorMessage: turnResult.errorMessage,
    tokenUsage: turnResult.tokenUsage,
    status: turnResult.status,
    threadId,
    turnId,
  });
}

function toTurnLogContextFields(context: TurnLogContext):
  | {
      source: "heartbeat";
    }
  | {
      source: "cron";
    }
  | {
      source: "discord";
      channelId: string;
      messageId: string;
    } {
  if (context.source === "heartbeat" || context.source === "cron") {
    return {
      source: context.source,
    };
  }

  return {
    channelId: context.channelId,
    messageId: context.messageId,
    source: "discord",
  };
}
