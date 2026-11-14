import type { LunaEvent } from "../domain/luna-event";

export type EventExecutionResult =
	| Readonly<{ status: "completed" }>
	| Readonly<{ error: unknown; status: "failed" }>;

export type EventExecutionHooks = Readonly<{
	afterRunStarted?: () => Promise<void>;
	// 最初の実行の結果。バックグラウンド実行の終了を受けた続きの実行は待たない。
	afterFirstRun?: (result: EventExecutionResult) => void;
}>;

export interface EventExecutionPort {
	// バックグラウンド実行が残っていれば、その続きの実行も終えてから解決する。
	execute(event: LunaEvent, hooks?: EventExecutionHooks): Promise<EventExecutionResult>;
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
