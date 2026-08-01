import type { AgentOutput } from "../../../discord/domain/discord-action";

export type ThreadId = string;
export type TurnId = string;

export type AgentThreadSummary = {
  archived: boolean;
  id: ThreadId;
  updatedAt?: number | undefined;
};

export type AgentTurnResult =
  | {
      output: AgentOutput;
      status: "completed";
    }
  | {
      errorMessage?: string;
      status: "failed" | "interrupted";
    };

export type StartedAgentTurn = {
  completion: Promise<AgentTurnResult>;
  turnId: TurnId;
};

export interface AgentThreadPort {
  archiveThread(threadId: ThreadId): Promise<void>;
  deleteThread(threadId: ThreadId): Promise<void>;
  listThreads(input?: { archived?: boolean; cursor?: string; limit?: number }): Promise<{
    data: AgentThreadSummary[];
    nextCursor?: string;
  }>;
  openThread(input: {
    baseInstructions: string;
    config: Record<string, unknown>;
    cwd: string;
    developerInstructions: string;
  }): Promise<ThreadId>;
}

export interface AgentTurnPort {
  interruptTurn(threadId: ThreadId, turnId: TurnId): Promise<void>;
  startTurn(threadId: ThreadId, input: string): Promise<StartedAgentTurn>;
  steerTurn(threadId: ThreadId, turnId: TurnId, input: string): Promise<void>;
}

export type AgentRuntimePort = AgentThreadPort & AgentTurnPort;
