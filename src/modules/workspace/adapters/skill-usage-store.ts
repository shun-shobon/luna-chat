import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

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
	#chain: Promise<void> = Promise.resolve();

	constructor(private readonly filePath: string) {}

	record(names: readonly string[], at: Date): Promise<void> {
		if (names.length === 0) return Promise.resolve();
		this.#chain = this.#chain.then(async () => {
			const usage = await this.#read();
			for (const name of names) {
				usage[name] = { lastUsedAt: at.toISOString(), uses: (usage[name]?.uses ?? 0) + 1 };
			}
			await mkdir(dirname(this.filePath), { recursive: true });
			const temporary = join(dirname(this.filePath), `.skill-usage.${String(process.pid)}.tmp`);
			await writeFile(temporary, `${JSON.stringify(usage, null, "\t")}\n`);
			await rename(temporary, this.filePath);
		});
		return this.#chain;
	}

	async #read(): Promise<Record<string, { lastUsedAt: string; uses: number }>> {
		try {
			return usageSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
		} catch (error: unknown) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
			throw error;
		}
	}
}
