import type { LunaEvent } from "../domain/luna-event";

export type EventExecutionResult =
	| Readonly<{ status: "completed" }>
	| Readonly<{ error: unknown; status: "failed" }>;

export interface EventExecutionPort {
	execute(event: LunaEvent, afterTurnStarted?: () => Promise<void>): Promise<EventExecutionResult>;
}

export type EventExecutionStatus = Readonly<{
	eventId: string;
	eventSource: string;
	eventType: string;
	phase: "opening" | "turn" | "retry_wait" | "effects";
	startedAt: string;
	subject: string | null;
	threadId: string | null;
}>;
