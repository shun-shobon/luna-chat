import { appendFile, mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";

import { hasErrorCode } from "../../../../../shared/error-code";
import { formatLocalDate } from "../../../../../shared/local-date";
import type { LoggerPort } from "../../../../observability/ports/logger-port";

const DATE_DIRECTORY = /^\d{4}-\d{2}-\d{2}$/u;

export function transcriptFilePath(root: string, openedAt: Date, sessionId: string): string {
	return path.join(root, formatLocalDate(openedAt), `${sessionId}.jsonl`);
}

// listener を止めないよう書き込みは待たずに順に積み、close で待つ。
export class TranscriptWriter {
	readonly #filePath: string;
	readonly #logger: LoggerPort;
	readonly #sessionId: string;
	#tail: Promise<void> = Promise.resolve();

	constructor(input: { filePath: string; logger: LoggerPort; sessionId: string }) {
		this.#filePath = input.filePath;
		this.#logger = input.logger;
		this.#sessionId = input.sessionId;
	}

	append(record: Readonly<Record<string, unknown>>): void {
		const line = `${JSON.stringify(record)}\n`;
		this.#tail = this.#tail.then(async () => {
			try {
				// 保持期間の掃除が空の日付ディレクトリを消すことがあるため、毎回作り直す。
				await mkdir(path.dirname(this.#filePath), { recursive: true });
				await appendFile(this.#filePath, line, "utf8");
			} catch (error: unknown) {
				this.#logger.error("agent.pi.transcript_write_failed", {
					error: error instanceof Error ? error.message : String(error),
					filePath: this.#filePath,
					sessionId: this.#sessionId,
				});
			}
		});
	}

	flush(): Promise<void> {
		return this.#tail;
	}
}

// 開いたままのセッションは開いた日のディレクトリに追記し続けるため、日付ではなくファイルの更新時刻で判定する。
export async function pruneTranscripts(
	root: string,
	now: Date,
	retentionMs: number,
): Promise<number> {
	const cutoff = now.getTime() - retentionMs;
	let removed = 0;
	for (const directory of await readDirectoryNames(root)) {
		if (!DATE_DIRECTORY.test(directory)) {
			continue;
		}
		const directoryPath = path.join(root, directory);
		const entries = await readdir(directoryPath, { withFileTypes: true });
		let remaining = entries.length;
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
				continue;
			}
			const filePath = path.join(directoryPath, entry.name);
			const stats = await stat(filePath);
			if (stats.mtimeMs < cutoff) {
				await rm(filePath, { force: true });
				removed += 1;
				remaining -= 1;
			}
		}
		if (remaining === 0) {
			await rmdir(directoryPath).catch((error: unknown) => {
				if (!hasErrorCode(error, "ENOTEMPTY") && !hasErrorCode(error, "ENOENT")) {
					throw error;
				}
			});
		}
	}
	return removed;
}

async function readDirectoryNames(root: string): Promise<string[]> {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch (error: unknown) {
		if (hasErrorCode(error, "ENOENT")) {
			return [];
		}
		throw error;
	}
}
