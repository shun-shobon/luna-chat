import { logger } from "../../../shared/logger";
import type { RuntimeMessage } from "../../conversation/domain/runtime-message";
import type { ReasoningEffort } from "../codex-generated/ReasoningEffort";
import type { AiRuntimePort, StartedTurn } from "../ports/outbound/ai-runtime-port";

import {
  buildHeartbeatPromptBundle,
  buildPromptBundle,
  buildSteerPrompt,
  type AiInput,
} from "./prompt-composer";
import { buildThreadConfig } from "./thread-config-factory";

export type HeartbeatInput = {
  prompt: string;
};

export interface AiService {
  generateReply(input: AiInput): Promise<void>;
  generateHeartbeat(input: HeartbeatInput): Promise<void>;
}

type ChannelSessionCoordinatorOptions = {
  createRuntime: () => AiRuntimePort;
  discordMcpServerUrl: string;
  onDiscordTurnCompleted?: (channelId: string) => void | Promise<void>;
  reasoningEffort: ReasoningEffort;
  workspaceDir: string;
};

type ActiveChannelSession = {
  channelId: string;
  runtime: AiRuntimePort;
  phase: "booting" | "running";
  opChain: Promise<void>;
  threadId: string | undefined;
  activeTurnId: string | undefined;
  turnCompletion: Promise<void> | undefined;
};

export class ChannelSessionCoordinator implements AiService {
  private readonly activeSessions = new Map<string, ActiveChannelSession>();

  constructor(private readonly options: ChannelSessionCoordinatorOptions) {}

  async generateReply(input: AiInput): Promise<void> {
    const handled = await this.tryHandleExistingSession(input);
    if (handled) {
      return;
    }

    await this.startNewSession(input);
  }

  async generateHeartbeat(input: HeartbeatInput): Promise<void> {
    const runtime = this.options.createRuntime();
    let threadId: string | undefined;
    let turnId: string | undefined;

    try {
      await runtime.initialize();
      const promptBundle = await buildHeartbeatPromptBundle(
        this.options.workspaceDir,
        input.prompt,
      );
      threadId = await runtime.startThread({
        config: buildThreadConfig(this.options.reasoningEffort, this.options.discordMcpServerUrl),
        developerRolePrompt: promptBundle.developerRolePrompt,
        instructions: promptBundle.instructions,
      });

      const startedTurn = await runtime.startTurn(threadId, promptBundle.userRolePrompt);
      turnId = startedTurn.turnId;
      const turnResult = await startedTurn.completion;
      logTurnResult(threadId, turnId, turnResult);
      if (turnResult.status !== "completed") {
        const errorMessage =
          turnResult.errorMessage ?? `app-server turn status is ${turnResult.status}`;
        throw new Error(errorMessage);
      }
    } catch (error: unknown) {
      logger.debug("ai.heartbeat.failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        threadId,
        turnId,
      });
      throw error;
    } finally {
      runtime.close();
    }
  }

  private async tryHandleExistingSession(input: AiInput): Promise<boolean> {
    const session = this.activeSessions.get(input.currentMessage.channelId);
    if (!session) {
      return false;
    }

    return await this.enqueueSessionOperation(session, async () => {
      return await this.appendMessageToSession(session, input.currentMessage);
    });
  }

  private async startNewSession(input: AiInput): Promise<void> {
    const existingSession = this.activeSessions.get(input.currentMessage.channelId);
    if (existingSession) {
      const handled = await this.enqueueSessionOperation(existingSession, async () => {
        return await this.appendMessageToSession(existingSession, input.currentMessage);
      });
      if (handled) {
        return;
      }
    }

    const session = this.createSession(input.currentMessage.channelId);
    this.activeSessions.set(session.channelId, session);

    try {
      await this.enqueueSessionOperation(session, async () => {
        await session.runtime.initialize();
        const promptBundle = await buildPromptBundle(input, this.options.workspaceDir);

        const threadId = await session.runtime.startThread({
          config: buildThreadConfig(this.options.reasoningEffort, this.options.discordMcpServerUrl),
          developerRolePrompt: promptBundle.developerRolePrompt,
          instructions: promptBundle.instructions,
        });
        session.phase = "running";
        session.threadId = threadId;

        await this.startTurn(session, {
          messageId: input.currentMessage.id,
          prompt: promptBundle.userRolePrompt,
        });
      });

      const turnCompletion = session.turnCompletion;
      if (!turnCompletion) {
        throw new Error("Active turn was not started.");
      }
      await turnCompletion;
    } catch (error: unknown) {
      this.disposeSession(session);
      logger.debug("ai.turn.failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        messageId: input.currentMessage.id,
        threadId: session.threadId,
      });
      throw error;
    }
  }

  private async appendMessageToSession(
    session: ActiveChannelSession,
    currentMessage: RuntimeMessage,
  ): Promise<boolean> {
    if (this.activeSessions.get(session.channelId) !== session) {
      return false;
    }

    if (!session.threadId || !session.activeTurnId) {
      return false;
    }

    const steerPrompt = buildSteerPrompt(currentMessage);
    const expectedTurnId = session.activeTurnId;

    try {
      await session.runtime.steerTurn(session.threadId, expectedTurnId, steerPrompt);
      logger.debug("ai.turn.steered", {
        channelId: session.channelId,
        messageId: currentMessage.id,
        threadId: session.threadId,
        turnId: expectedTurnId,
      });
      return true;
    } catch (error: unknown) {
      logger.debug("ai.turn.steer_failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        messageId: currentMessage.id,
        threadId: session.threadId,
        turnId: expectedTurnId,
      });
      await this.startTurn(session, {
        messageId: currentMessage.id,
        prompt: steerPrompt,
      });
      return true;
    }
  }

  private createSession(channelId: string): ActiveChannelSession {
    const runtime = this.options.createRuntime();

    return {
      channelId,
      runtime,
      opChain: Promise.resolve(),
      phase: "booting",
      activeTurnId: undefined,
      threadId: undefined,
      turnCompletion: undefined,
    };
  }

  private async startTurn(
    session: ActiveChannelSession,
    input: {
      prompt: string;
      messageId: string;
    },
  ): Promise<void> {
    const threadId = session.threadId;
    if (!threadId) {
      throw new Error("Thread is not started yet.");
    }

    const startedTurn = await session.runtime.startTurn(threadId, input.prompt);
    session.phase = "running";
    session.activeTurnId = startedTurn.turnId;

    logger.debug("ai.turn.started", {
      channelId: session.channelId,
      messageId: input.messageId,
      threadId,
      turnId: startedTurn.turnId,
    });

    const turnCompletion = this.trackTurnCompletion(session, startedTurn, {
      threadId,
      turnId: startedTurn.turnId,
    });
    turnCompletion.catch(() => undefined);
    session.turnCompletion = turnCompletion;
  }

  private trackTurnCompletion(
    session: ActiveChannelSession,
    startedTurn: StartedTurn,
    meta: {
      threadId: string;
      turnId: string;
    },
  ): Promise<void> {
    return startedTurn.completion
      .then((turnResult) => {
        logTurnResult(meta.threadId, meta.turnId, turnResult);
        if (turnResult.status !== "completed") {
          const errorMessage =
            turnResult.errorMessage ?? `app-server turn status is ${turnResult.status}`;
          throw new Error(errorMessage);
        }
      })
      .finally(() => {
        if (this.activeSessions.get(session.channelId) !== session) {
          return;
        }
        if (session.activeTurnId !== meta.turnId) {
          return;
        }

        this.runOnDiscordTurnCompleted(session.channelId);
        this.activeSessions.delete(session.channelId);
        session.activeTurnId = undefined;
        session.turnCompletion = undefined;
        session.runtime.close();
      });
  }

  private runOnDiscordTurnCompleted(channelId: string): void {
    const callback = this.options.onDiscordTurnCompleted;
    if (!callback) {
      return;
    }

    void Promise.resolve(callback(channelId)).catch((error: unknown) => {
      logger.warn("Failed to run onDiscordTurnCompleted callback:", error);
    });
  }

  private disposeSession(session: ActiveChannelSession): void {
    if (this.activeSessions.get(session.channelId) === session) {
      this.activeSessions.delete(session.channelId);
    }
    session.activeTurnId = undefined;
    session.turnCompletion = undefined;
    session.runtime.close();
  }

  private async enqueueSessionOperation<T>(
    session: ActiveChannelSession,
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

function logTurnResult(
  threadId: string,
  turnId: string,
  turnResult: {
    assistantText: string;
    errorMessage?: string;
    mcpToolCalls: Array<{
      arguments: unknown;
      server: string;
      status: "completed" | "failed" | "inProgress";
      tool: string;
    }>;
    status: "completed" | "failed" | "interrupted";
  },
): void {
  logger.debug("ai.turn.assistant_output", {
    assistantText: turnResult.assistantText,
    threadId,
    turnId,
  });
  for (const toolCall of turnResult.mcpToolCalls) {
    logger.debug("ai.turn.mcp_tool_call", {
      arguments: toolCall.arguments,
      server: toolCall.server,
      status: toolCall.status,
      threadId,
      tool: toolCall.tool,
      turnId,
    });
  }
  logger.debug("ai.turn.completed", {
    errorMessage: turnResult.errorMessage,
    status: turnResult.status,
    threadId,
    turnId,
  });
}
