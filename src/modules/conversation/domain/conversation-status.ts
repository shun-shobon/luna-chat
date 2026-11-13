import type { JsonValue } from "../../../shared/json";

export type ConversationPhase =
	| "collecting"
	| "opening"
	| "running"
	| "retry_wait"
	| "compacting"
	| "idle"
	| "closing"
	| "closed";

export type ConversationRunPurpose = "conversation" | "session_memory";

export type ConversationStatus = Readonly<{
	context: JsonValue;
	idleDeadlineAt: string | null;
	key: string;
	modelSettings: Readonly<{ provider: string; model: string; thinking: string }> | null;
	phase: Exclude<ConversationPhase, "closed">;
	phaseSince: string;
	purpose: ConversationRunPurpose | null;
	queuedEvents: number;
	retries: number;
	sessionId: string | null;
	source: string;
}>;
