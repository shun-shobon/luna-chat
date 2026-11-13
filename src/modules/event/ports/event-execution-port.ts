import type { LunaEvent } from "../domain/luna-event";

export type EventExecutionResult =
	| Readonly<{ status: "completed" }>
	| Readonly<{ error: unknown; status: "failed" }>;

export interface EventExecutionPort {
	execute(event: LunaEvent, afterRunStarted?: () => Promise<void>): Promise<EventExecutionResult>;
}

export type EventExecutionStatus = Readonly<{
	eventId: string;
	eventSource: string;
	eventType: string;
	phase: "opening" | "running" | "retry_wait" | "compacting";
	startedAt: string;
	subject: string | null;
	sessionId: string | null;
}>;
