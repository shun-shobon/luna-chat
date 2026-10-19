import type { JsonObject } from "../../../../shared/json";

export type ThreadId = string;
export type TurnId = string;

export type AgentTurnRequest = Readonly<{
	effort?: string;
	input: string;
	model?: string;
	outputSchema: JsonObject;
}>;

export type AgentModel = Readonly<{
	displayName: string;
	model: string;
	supportedReasoningEfforts: readonly string[];
}>;

export type AgentThreadSummary = {
	id: ThreadId;
	updatedAt?: number | undefined;
};

export type AgentTurnResult =
	| Readonly<{
			// steerで受けた入力を同じturnで続けて処理すると最終回答が複数出るため、出た順にすべて返す。
			outputTexts: readonly [string, ...string[]];
			status: "completed";
	  }>
	| Readonly<{
			errorMessage?: string;
			retryable: boolean;
			status: "failed" | "interrupted";
	  }>;

export const TURN_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000, 180_000];

export type StartedAgentTurn = {
	completion: Promise<AgentTurnResult>;
	turnId: TurnId;
};

export type AgentThreadInput = Readonly<{
	baseInstructions: string;
	config: JsonObject;
	cwd: string;
	developerInstructions: string;
}>;

interface AgentThreadPort {
	archiveThread(threadId: ThreadId): Promise<void>;
	deleteThread(threadId: ThreadId): Promise<void>;
	listModels(): Promise<readonly AgentModel[]>;
	listArchivedThreads(cursor?: string): Promise<{
		data: AgentThreadSummary[];
		nextCursor?: string;
	}>;
	openThread(input: AgentThreadInput): Promise<ThreadId>;
}

interface AgentTurnPort {
	interruptTurn(threadId: ThreadId, turnId: TurnId): Promise<void>;
	startTurn(threadId: ThreadId, request: AgentTurnRequest): Promise<StartedAgentTurn>;
	steerTurn(threadId: ThreadId, turnId: TurnId, input: string): Promise<void>;
}

export type AgentRuntimePort = AgentThreadPort & AgentTurnPort;
