import type { AutomationInput } from "../domain/automation-input";
import type { AutomationAgentPort } from "../ports/automation-agent-port";
import type { AutomationLogPort } from "../ports/automation-log-port";

export type AutomationExecutionResult =
  | { status: "completed" }
  | { error: unknown; status: "failed" };

export interface AutomationExecutionPort {
  execute(
    input: AutomationInput,
    afterTurnStarted?: () => Promise<void>,
  ): Promise<AutomationExecutionResult>;
}

export class AutomationExecutor implements AutomationExecutionPort {
  readonly #agent: AutomationAgentPort;
  readonly #logger: AutomationLogPort;

  constructor(input: { agent: AutomationAgentPort; logger: AutomationLogPort }) {
    this.#agent = input.agent;
    this.#logger = input.logger;
  }

  async execute(
    input: AutomationInput,
    afterTurnStarted?: () => Promise<void>,
  ): Promise<AutomationExecutionResult> {
    let threadId: string | undefined;
    let result: AutomationExecutionResult;

    try {
      threadId = await this.#agent.openAutomationThread();
      const startedTurn = await this.#agent.startAutomationTurn(threadId, input);
      await afterTurnStarted?.();
      await startedTurn.completion;
      result = { status: "completed" };
    } catch (error: unknown) {
      this.#logger.error("automation.execution.failed", {
        error,
        source: input.source,
        threadId,
      });
      result = { error, status: "failed" };
    }

    if (threadId !== undefined) {
      await this.#agent.archiveThread(threadId).catch((error: unknown) => {
        this.#logger.error("automation.thread.archive_failed", { error, threadId });
      });
    }

    return result;
  }
}
