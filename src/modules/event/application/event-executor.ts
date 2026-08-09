import type { LoggerPort } from "../../observability/ports/logger-port";
import type { LunaEvent } from "../domain/luna-event";
import type { EventAgentPort } from "../ports/event-agent-port";
import type { EventExecutionPort, EventExecutionResult } from "../ports/event-execution-port";

export class EventExecutor implements EventExecutionPort {
  public constructor(
    private readonly dependencies: Readonly<{
      agent: EventAgentPort;
      logger: LoggerPort;
    }>,
  ) {}

  public async execute(
    event: LunaEvent,
    afterTurnStarted?: () => Promise<void>,
  ): Promise<EventExecutionResult> {
    let threadId: string | undefined;
    let result: EventExecutionResult;

    try {
      threadId = await this.dependencies.agent.openEventThread();
      const startedTurn = await this.dependencies.agent.startEventTurn(threadId, event);
      await afterTurnStarted?.();
      await startedTurn.completion;
      result = { status: "completed" };
    } catch (error: unknown) {
      this.dependencies.logger.log(
        "error",
        "event.execution_failed",
        threadId === undefined ? {} : { threadId },
        { error, eventSource: event.source, eventType: event.type },
      );
      result = { error, status: "failed" };
    }

    if (threadId !== undefined) {
      await this.dependencies.agent.archiveThread(threadId).catch((error: unknown) => {
        this.dependencies.logger.log(
          "error",
          "event.thread_archive_failed",
          { threadId },
          { error },
        );
      });
    }

    return result;
  }
}
