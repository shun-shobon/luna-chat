import type { LogEntry, RecentLogRecord } from "../ports/logger-port";
import { serializeLogValue } from "./log-serializer";

const TRUNCATED_SUFFIX = "…(truncated)";

// LOG_LEVELに関係なくinfo以上を本文込みで保持する。標準出力のログ量やレベルを変えずに直近の様子を見せるため。
export class RecentLogBuffer {
	readonly #records: RecentLogRecord[] = [];
	#seq = 0;

	constructor(
		private readonly options: Readonly<{
			capacity: number;
			maxFieldLength: number;
			now: () => Date;
		}>,
	) {}

	record(entry: LogEntry): void {
		this.#seq += 1;
		this.#records.push({
			seq: this.#seq,
			timestamp: this.options.now().toISOString(),
			level: entry.level,
			event: entry.event,
			context: entry.context,
			details: this.#stringify(entry.details),
			payload: this.#stringify(entry.payload),
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
