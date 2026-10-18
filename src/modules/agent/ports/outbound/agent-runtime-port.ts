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
