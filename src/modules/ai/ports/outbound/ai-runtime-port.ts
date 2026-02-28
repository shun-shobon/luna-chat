import type { TurnResult } from "../../domain/turn-result";

export type McpToolCallStartedEvent = {
  threadId: string;
  turnId: string;
  server: string;
  tool: string;
};

export type McpToolCallCompletedEvent = {
  threadId: string;
  turnId: string;
  server: string;
  tool: string;
  status: "completed" | "failed" | "inProgress";
};

export type TurnObserver = {
  onMcpToolCallStarted?: (event: McpToolCallStartedEvent) => void;
  onMcpToolCallCompleted?: (event: McpToolCallCompletedEvent) => void;
};

export type StartedTurn = {
  turnId: string;
  completion: Promise<TurnResult>;
};

export interface AiRuntimePort {
  close(): void;
  initialize(): Promise<void>;
  startThread(input: {
    instructions: string;
    developerRolePrompt: string;
    config?: Record<string, unknown>;
  }): Promise<string>;
  startTurn(threadId: string, prompt: string, observer?: TurnObserver): Promise<StartedTurn>;
  steerTurn(threadId: string, expectedTurnId: string, prompt: string): Promise<void>;
}
