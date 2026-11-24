import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { jsonValueSchema } from "../../../shared/json";
import type { JsonValue } from "../../../shared/json";
import { BUILTIN_ACTION_TYPES } from "../domain/action";
import type { CustomCandidate } from "../domain/action";
import type { CustomActionsReport } from "../ports/minecraft-connection-port";

// エージェントがワークスペースに書いた行動（docs/minecraft.md の「エージェントが足す行動」）を読み、候補の列挙と実行を受け持つ。ワーカースレッドで動く。

const NAME_PATTERN = /^[a-z0-9_]{1,40}$/u;
const EXTENSION = ".mjs";

const functionSchema = z.custom<(...parameters: unknown[]) => unknown>(
	(value) => typeof value === "function",
	"must be a function",
);
const moduleSchema = z.looseObject({
	timeoutMs: z.number().int().min(1_000).max(300_000),
	candidates: functionSchema,
	run: functionSchema,
});
const candidatesSchema = z.array(
	z.strictObject({
		description: z.string().trim().min(1).max(300),
		args: jsonValueSchema.optional(),
	}),
);
const runResultSchema = z.union([z.string(), z.undefined()]);

type LoadedAction = Readonly<{
	name: string;
	modifiedMs: number;
	timeoutMs: number;
	candidates: (context: unknown) => unknown;
	run: (context: unknown, args: JsonValue | null, signal: AbortSignal) => unknown;
}>;

export class CustomActionRegistry {
	readonly #actions = new Map<string, LoadedAction>();
	// 読めなかったファイルの更新時刻と理由。同じ版を毎回読み直さないため。
	readonly #failed = new Map<string, Readonly<{ modifiedMs: number; error: string }>>();

	constructor(private readonly directory: string) {}

	// ファイルの増減と更新を読み直してから、今の候補を列挙する。
	async list(context: unknown): Promise<CustomActionsReport> {
		await this.#refresh();
		const errors = [...this.#failed].map(([name, failure]) => ({ name, error: failure.error }));
		const candidates: CustomCandidate[] = [];
		for (const action of this.#actions.values()) {
			try {
				const listed = candidatesSchema.parse(action.candidates(context));
				for (const candidate of listed) {
					candidates.push({
						name: action.name,
						description: candidate.description,
						args: candidate.args ?? null,
						timeoutMs: action.timeoutMs,
					});
				}
			} catch (error: unknown) {
				errors.push({ name: action.name, error: `candidates failed: ${describe(error)}` });
			}
		}
		return { loaded: [...this.#actions.keys()], candidates, errors };
	}

	async run(
		name: string,
		args: JsonValue | null,
		context: unknown,
		signal: AbortSignal,
	): Promise<string | undefined> {
		const action = this.#actions.get(name);
		if (action === undefined) throw new Error(`the action ${name} is no longer loaded`);
		const result = runResultSchema.safeParse(await action.run(context, args, signal));
		if (!result.success) throw new Error(`run of ${name} must return a string or nothing`);
		return result.data;
	}

	async #refresh(): Promise<void> {
		const files = await this.#files();
		for (const name of this.#actions.keys()) {
			if (!files.has(name)) this.#actions.delete(name);
		}
		for (const name of this.#failed.keys()) {
			if (!files.has(name)) this.#failed.delete(name);
		}
		for (const [name, modifiedMs] of files) {
			if (this.#actions.get(name)?.modifiedMs === modifiedMs) continue;
			if (this.#failed.get(name)?.modifiedMs === modifiedMs) continue;
			try {
				this.#actions.set(name, await this.#load(name, modifiedMs));
				this.#failed.delete(name);
			} catch (error: unknown) {
				this.#actions.delete(name);
				this.#failed.set(name, { modifiedMs, error: describe(error) });
			}
		}
	}

	async #files(): Promise<Map<string, number>> {
		let entries;
		try {
			entries = await readdir(this.directory, { withFileTypes: true });
		} catch (error: unknown) {
			// エージェントがまだ行動を書いていなければ、ディレクトリはない。
			if (isMissing(error)) return new Map();
			throw error;
		}
		const files = new Map<string, number>();
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(EXTENSION)) continue;
			const name = entry.name.slice(0, -EXTENSION.length);
			files.set(name, (await stat(join(this.directory, entry.name))).mtimeMs);
		}
		return files;
	}

	async #load(name: string, modifiedMs: number): Promise<LoadedAction> {
		if (!NAME_PATTERN.test(name)) {
			throw new Error("the file name must be 1-40 lowercase letters, digits, or _");
		}
		if (BUILTIN_ACTION_TYPES.has(name)) {
			throw new Error(`${name} is a built-in action`);
		}
		const url = pathToFileURL(join(this.directory, `${name}${EXTENSION}`));
		// import() は URL ごとに結果を保持し、消す手段がないため、更新時刻をクエリに付けて別の URL として読む。
		url.searchParams.set("v", String(modifiedMs));
		const loaded = moduleSchema.parse(await import(url.href));
		return {
			name,
			modifiedMs,
			timeoutMs: loaded.timeoutMs,
			candidates: loaded.candidates,
			run: loaded.run,
		};
	}
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function describe(error: unknown): string {
	if (error instanceof z.ZodError) return z.prettifyError(error);
	return error instanceof Error ? error.message : String(error);
}
