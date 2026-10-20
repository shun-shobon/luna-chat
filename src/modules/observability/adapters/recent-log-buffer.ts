import type { LogContext, LoggerPort, LogLevel, RecentLogRecord } from "../ports/logger-port";
import { serializeLogValue } from "./json-lines-logger";

const TRUNCATED_SUFFIX = "…(truncated)";

// LOG_LEVELに関係なくinfo以上を本文込みで保持する。標準出力のログ量やレベルを変えずに直近の様子を見せるため。
export class RecentLogBuffer implements LoggerPort {
	readonly #records: RecentLogRecord[] = [];
	#seq = 0;

	constructor(
		private readonly options: Readonly<{
			capacity: number;
			excludedEvents: ReadonlySet<string>;
			maxFieldLength: number;
			now: () => Date;
		}>,
	) {}

	log(
		level: LogLevel,
		event: string,
		context: LogContext = {},
		details?: Readonly<Record<string, unknown>>,
		payload?: unknown,
	): void {
		if (level === "trace" || level === "debug" || this.options.excludedEvents.has(event)) return;
		this.#seq += 1;
		this.#records.push({
			seq: this.#seq,
			timestamp: this.options.now().toISOString(),
			level,
			event,
			context,
			details: this.#stringify(details),
			payload: this.#stringify(payload),
		});
		if (this.#records.length > this.options.capacity) this.#records.shift();
	}

	list(): readonly RecentLogRecord[] {
		return [...this.#records];
	}

	#stringify(value: unknown): string | null {
		if (value === undefined) return null;
		const text = JSON.stringify(serializeLogValue(value));
		if (text.length <= this.options.maxFieldLength) return text;
		return text.slice(0, this.options.maxFieldLength) + TRUNCATED_SUFFIX;
	}
}
