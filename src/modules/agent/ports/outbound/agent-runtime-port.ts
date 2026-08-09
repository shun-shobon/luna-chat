export type ThreadId = string;
export type TurnId = string;

export type AgentTurnRequest = Readonly<{
  input: string;
  outputSchema: Record<string, unknown>;
}>;

export type AgentThreadSummary = {
  archived: boolean;
  id: ThreadId;
  updatedAt?: number | undefined;
};

export type AgentTurnResult =
  | Readonly<{
      outputText: string;
      status: "completed";
    }>
  | Readonly<{
      errorMessage?: string;
      status: "failed" | "interrupted";
    }>;

export type StartedAgentTurn = {
  completion: Promise<AgentTurnResult>;
  turnId: TurnId;
};

export type AgentThreadInput = Readonly<{
  baseInstructions: string;
  config: Record<string, unknown>;
  cwd: string;
  developerInstructions: string;
  executionOwnerId: string;
}>;

interface AgentThreadPort {
  archiveThread(threadId: ThreadId): Promise<void>;
  deleteThread(threadId: ThreadId): Promise<void>;
  listThreads(input?: { archived?: boolean; cursor?: string; limit?: number }): Promise<{
    data: AgentThreadSummary[];
    nextCursor?: string;
  }>;
  openThread(input: Omit<AgentThreadInput, "executionOwnerId">): Promise<ThreadId>;
}

interface AgentTurnPort {
  interruptTurn(threadId: ThreadId, turnId: TurnId): Promise<void>;
  startTurn(threadId: ThreadId, request: AgentTurnRequest): Promise<StartedAgentTurn>;
  steerTurn(threadId: ThreadId, turnId: TurnId, input: string): Promise<void>;
}

export type AgentRuntimePort = AgentThreadPort & AgentTurnPort;
