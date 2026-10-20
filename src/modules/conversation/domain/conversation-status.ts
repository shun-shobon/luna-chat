import type { JsonValue } from "../../../shared/json";

export type ConversationPhase =
	| "collecting"
	| "opening"
	| "starting"
	| "turn"
	| "retry_wait"
	| "effects"
	| "orphaned_effects"
	| "idle"
	| "archiving"
	| "closed";

export type ConversationTurnPurpose = "conversation" | "session_memory";

export type ConversationModelSettings = Readonly<{ model: string; effort: string }>;

export type ConversationStatus = Readonly<{
	context: JsonValue;
	idleDeadlineAt: string | null;
	key: string;
	modelSettings: ConversationModelSettings | null;
	phase: Exclude<ConversationPhase, "closed">;
	phaseSince: string;
	purpose: ConversationTurnPurpose | null;
	queuedEvents: number;
	retries: number;
	source: string;
	threadId: string | null;
	turnId: string | null;
}>;
