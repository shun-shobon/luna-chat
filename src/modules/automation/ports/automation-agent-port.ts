import type { AutomationInput } from "../domain/automation-input";

export type AutomationThreadId = string;

export type StartedAutomationTurn = {
  completion: Promise<void>;
};

export type ArchivedAgentThread = {
  id: string;
  updatedAt: number | undefined;
};

export interface AutomationAgentPort {
  archiveThread(threadId: AutomationThreadId): Promise<void>;
  deleteArchivedThread(threadId: AutomationThreadId): Promise<void>;
  listArchivedThreads(input: { cursor?: string }): Promise<{
    data: ArchivedAgentThread[];
    nextCursor?: string;
  }>;
  openAutomationThread(): Promise<AutomationThreadId>;
  startAutomationTurn(
    threadId: AutomationThreadId,
    input: AutomationInput,
  ): Promise<StartedAutomationTurn>;
}
