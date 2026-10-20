export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type LogContext = Readonly<{
	actionIndex?: number | undefined;
	conversationScope?: string | undefined;
	conversationSession?: string | undefined;
	effectIndex?: number | undefined;
	eventId?: string | undefined;
	jobId?: string | undefined;
	requestId?: string | number | undefined;
	taskId?: string | undefined;
	threadId?: string | undefined;
	toolCallId?: string | undefined;
	turnId?: string | undefined;
	typingLeaseId?: string | undefined;
}>;

export type RecentLogRecord = Readonly<{
	seq: number;
	timestamp: string;
	level: LogLevel;
	event: string;
	context: LogContext;
	details: string | null;
	payload: string | null;
}>;

export interface LoggerPort {
	log(
		level: LogLevel,
		event: string,
		context?: LogContext,
		details?: Readonly<Record<string, unknown>>,
		payload?: unknown,
	): void;
}
