import type { TurnResult } from "../../domain/turn-result";

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
  startTurn(threadId: string, prompt: string): Promise<StartedTurn>;
  steerTurn(threadId: string, expectedTurnId: string, prompt: string): Promise<void>;
}
