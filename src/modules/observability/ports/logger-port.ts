export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type LogContext = Readonly<{
	conversationScope?: string | undefined;
	conversationSession?: string | undefined;
	eventId?: string | undefined;
	jobId?: string | undefined;
	taskId?: string | undefined;
}>;

export type LogDetails = Readonly<Record<string, unknown>>;

export type LogEntry = Readonly<{
	level: LogLevel;
	event: string;
	context: LogContext;
	details?: LogDetails | undefined;
	payload?: unknown;
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

// payload は LOG_LEVEL が debug 以下のときだけ標準出力へ出す本文。details は常に出す。
type LogMethod = (event: string, details?: LogDetails, payload?: unknown) => void;

export interface LoggerPort {
	child(context: LogContext): LoggerPort;
	info: LogMethod;
	warn: LogMethod;
	error: LogMethod;
}
