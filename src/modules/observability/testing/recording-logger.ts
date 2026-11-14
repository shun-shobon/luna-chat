import type { LogContext, LogDetails, LogEntry, LoggerPort } from "../ports/logger-port";

export type RecordingLogger = LoggerPort & Readonly<{ entries: LogEntry[] }>;

// テストで、child で束ねた context も含めて出力されたログを検証するためのロガー。
export function createRecordingLogger(
	entries: LogEntry[] = [],
	context: LogContext = {},
): RecordingLogger {
	const write =
		(level: LogEntry["level"]) =>
		(event: string, details?: LogDetails, payload?: unknown): void => {
			entries.push({
				level,
				event,
				context,
				...(details === undefined ? {} : { details }),
				...(payload === undefined ? {} : { payload }),
			});
		};
	return {
		entries,
		child: (childContext) => createRecordingLogger(entries, { ...context, ...childContext }),
		info: write("info"),
		warn: write("warn"),
		error: write("error"),
	};
}
