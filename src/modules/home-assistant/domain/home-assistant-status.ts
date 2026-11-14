import type { WatchConfig } from "./state-change";

export type HomeAssistantConnectionPhase = "connecting" | "connected" | "waiting_retry";

export type HomeAssistantConnectionStatus = Readonly<{
	phase: HomeAssistantConnectionPhase;
	phaseSince: string;
	nextRetryAt: string | null;
	lastError: Readonly<{ message: string; at: string }> | null;
}>;

export type WatchConfigState =
	| Readonly<{ status: "missing" }>
	| Readonly<{ status: "valid"; config: WatchConfig }>
	| Readonly<{ status: "invalid"; error: string }>;

export type HomeAssistantStatus = Readonly<{
	connection: HomeAssistantConnectionStatus;
	watchConfig: WatchConfigState;
	triggered: Readonly<{ count: number; lastAt: string | null }>;
}>;
