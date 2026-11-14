import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "../../../shared/atomic-file";
import { hasErrorCode } from "../../../shared/error-code";
import { SerialQueue } from "../../../shared/serial-queue";

const usageSchema = z.record(
	z.string(),
	z.strictObject({ lastUsedAt: z.iso.datetime(), uses: z.number().int().nonnegative() }),
);

const SKILL_PATH_PATTERN = /\.agents\/skills\/([^/\s"'`]+)\/SKILL\.md/gu;

// ツールの引数に出てきた SKILL.md のパスから、使われた skill の名前を拾う。
export function findSkillNames(argumentsValue: unknown): readonly string[] {
	const text =
		typeof argumentsValue === "object" && argumentsValue != null
			? JSON.stringify(argumentsValue)
			: String(argumentsValue);
	return [...new Set([...text.matchAll(SKILL_PATH_PATTERN)].flatMap((match) => match[1] ?? []))];
}

// 使われていない skill を日次整理で片付けられるよう、最後に読まれた時刻と回数を残す。
export class SkillUsageStore {
	readonly #queue = new SerialQueue();

	constructor(private readonly filePath: string) {}

	record(names: readonly string[], at: Date): Promise<void> {
		if (names.length === 0) return Promise.resolve();
		return this.#queue.run(async () => {
			const usage = await this.#read();
			for (const name of names) {
				usage[name] = { lastUsedAt: at.toISOString(), uses: (usage[name]?.uses ?? 0) + 1 };
			}
			await mkdir(dirname(this.filePath), { recursive: true });
			await writeFileAtomic(this.filePath, `${JSON.stringify(usage, null, "\t")}\n`);
		});
	}

	async #read(): Promise<Record<string, { lastUsedAt: string; uses: number }>> {
		try {
			return usageSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
		} catch (error: unknown) {
			if (hasErrorCode(error, "ENOENT")) return {};
			throw error;
		}
	}
}
