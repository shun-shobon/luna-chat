import { pino } from "pino";
import type { DestinationStream, Logger } from "pino";

import type { LogContext, LogDetails, LogEntry, LoggerPort, LogLevel } from "../ports/logger-port";
import { serializeLogValue } from "./log-serializer";

type RootLogger = LoggerPort & Readonly<{ flush(): Promise<void> }>;

export function createPinoLogger(
	input: Readonly<{
		level: LogLevel;
		onEntry: (entry: LogEntry) => void;
		destination?: DestinationStream;
		now?: () => Date;
	}>,
): RootLogger {
	const now = input.now ?? (() => new Date());
	const options = {
		level: input.level,
		base: null,
		messageKey: "event",
		timestamp: () => `,"timestamp":"${now().toISOString()}"`,
		formatters: { level: (label: string) => ({ level: label }) },
		serializers: { details: serializeLogValue, payload: serializeLogValue },
	};
	const root = input.destination === undefined ? pino(options) : pino(options, input.destination);
	const logger = new PinoLogger(
		root,
		{},
		{
			includePayload: input.level === "trace" || input.level === "debug",
			onEntry: input.onEntry,
		},
	);
	return Object.assign(logger, {
		flush: async () =>
			await new Promise<void>((resolve, reject) => {
				root.flush((error) => {
					if (error) reject(error);
					else resolve();
				});
			}),
	});
}

class PinoLogger implements LoggerPort {
	constructor(
		private readonly logger: Logger,
		private readonly context: LogContext,
		private readonly options: Readonly<{
			includePayload: boolean;
			onEntry: (entry: LogEntry) => void;
		}>,
	) {}

	child(context: LogContext): LoggerPort {
		return new PinoLogger(
			this.logger.child(context),
			{ ...this.context, ...context },
			this.options,
		);
	}

	info(event: string, details?: LogDetails, payload?: unknown): void {
		this.#write("info", event, details, payload);
	}

	warn(event: string, details?: LogDetails, payload?: unknown): void {
		this.#write("warn", event, details, payload);
	}

	error(event: string, details?: LogDetails, payload?: unknown): void {
		this.#write("error", event, details, payload);
	}

	#write(
		level: "info" | "warn" | "error",
		event: string,
		details: LogDetails | undefined,
		payload: unknown,
	): void {
		this.logger[level](
			{
				...(details === undefined ? {} : { details }),
				...(this.options.includePayload && payload !== undefined ? { payload } : {}),
			},
			event,
		);
		this.options.onEntry({ level, event, context: this.context, details, payload });
	}
}
