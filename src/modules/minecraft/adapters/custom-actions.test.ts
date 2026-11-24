import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CustomActionRegistry } from "./custom-actions";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
	);
});

async function actionsDirectory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "luna-minecraft-actions-"));
	directories.push(root);
	const path = join(root, "actions");
	await mkdir(path);
	return path;
}

// 更新時刻で読み直すかを決めるため、書くたびに時刻を進めて同じミリ秒に重ならないようにする。
let clock = Date.parse("2026-11-25T00:00:00.000Z");
async function writeAction(directory: string, file: string, source: string): Promise<void> {
	const path = join(directory, file);
	await writeFile(path, source);
	clock += 1_000;
	await utimes(path, clock / 1_000, clock / 1_000);
}

const BUILD_WALL = `
export const timeoutMs = 60000;
export function candidates(context) {
	return [{ description: "Build a wall of " + context.block, args: { length: 3 } }];
}
export async function run(context, args, signal) {
	return "built " + args.length + " blocks of " + context.block + (signal.aborted ? " (aborted)" : "");
}
`;

describe("CustomActionRegistry", () => {
	it("ディレクトリがなければ行動はなく、エラーにもしない", async () => {
		const registry = new CustomActionRegistry(join(await actionsDirectory(), "missing"));

		await expect(registry.list({})).resolves.toEqual({ loaded: [], candidates: [], errors: [] });
	});

	it("行動を読み、文脈を渡して候補を列挙し、選ばれた候補の引数で実行する", async () => {
		const directory = await actionsDirectory();
		await writeAction(directory, "build_wall.mjs", BUILD_WALL);
		await writeAction(directory, "notes.txt", "not an action");
		const registry = new CustomActionRegistry(directory);
		const context = { block: "cobblestone" };

		const report = await registry.list(context);

		expect(report).toEqual({
			loaded: ["build_wall"],
			candidates: [
				{
					name: "build_wall",
					description: "Build a wall of cobblestone",
					args: { length: 3 },
					timeoutMs: 60_000,
				},
			],
			errors: [],
		});
		await expect(
			registry.run("build_wall", { length: 3 }, context, new AbortController().signal),
		).resolves.toBe("built 3 blocks of cobblestone");
	});

	it("読めない行動は外して理由を返し、ほかの行動は使える", async () => {
		const directory = await actionsDirectory();
		await writeAction(directory, "build_wall.mjs", BUILD_WALL);
		await writeAction(directory, "syntax.mjs", "export const timeoutMs = ;");
		await writeAction(
			directory,
			"no_run.mjs",
			"export const timeoutMs = 1000; export function candidates() { return []; }",
		);
		await writeAction(directory, "too_long.mjs", BUILD_WALL.replace("60000", "600000"));
		await writeAction(directory, "Bad-Name.mjs", BUILD_WALL);
		await writeAction(directory, "mine.mjs", BUILD_WALL);
		const registry = new CustomActionRegistry(directory);

		const report = await registry.list({ block: "dirt" });

		expect(report.loaded).toEqual(["build_wall"]);
		expect(report.errors.map((entry) => entry.name).toSorted()).toEqual([
			"Bad-Name",
			"mine",
			"no_run",
			"syntax",
			"too_long",
		]);
		expect(report.errors.find((entry) => entry.name === "mine")?.error).toBe(
			"mine is a built-in action",
		);
	});

	it("候補の列挙の例外と形の誤りは、その回だけその行動を外す", async () => {
		const directory = await actionsDirectory();
		await writeAction(
			directory,
			"throws.mjs",
			`export const timeoutMs = 1000;
export function candidates() { throw new Error("no table nearby"); }
export async function run() {}`,
		);
		await writeAction(
			directory,
			"bad_shape.mjs",
			`export const timeoutMs = 1000;
export function candidates() { return [{ text: "missing description" }]; }
export async function run() {}`,
		);
		const registry = new CustomActionRegistry(directory);

		const report = await registry.list({});

		expect(report.loaded.toSorted()).toEqual(["bad_shape", "throws"]);
		expect(report.candidates).toEqual([]);
		expect(report.errors).toEqual(
			expect.arrayContaining([
				{ name: "throws", error: "candidates failed: no table nearby" },
				expect.objectContaining({ name: "bad_shape" }),
			]),
		);
	});

	it("変わったファイルを読み直し、消えたファイルの行動を外す", async () => {
		const directory = await actionsDirectory();
		await writeAction(directory, "build_wall.mjs", BUILD_WALL);
		await writeAction(directory, "syntax.mjs", "export const timeoutMs = ;");
		const registry = new CustomActionRegistry(directory);
		await registry.list({ block: "dirt" });

		await writeAction(
			directory,
			"build_wall.mjs",
			BUILD_WALL.replace("Build a wall", "Build a tower"),
		);
		await writeAction(directory, "syntax.mjs", BUILD_WALL.replace("Build a wall", "Fixed"));
		const changed = await registry.list({ block: "dirt" });
		await rm(join(directory, "syntax.mjs"));
		const removed = await registry.list({ block: "dirt" });

		expect(changed.candidates.map((candidate) => candidate.description)).toEqual([
			"Build a tower of dirt",
			"Fixed of dirt",
		]);
		expect(changed.errors).toEqual([]);
		expect(removed.loaded).toEqual(["build_wall"]);
	});

	it("実行の例外と文字列以外の戻り値は失敗にし、外れた行動は実行しない", async () => {
		const directory = await actionsDirectory();
		await writeAction(
			directory,
			"fails.mjs",
			`export const timeoutMs = 1000;
export function candidates() { return [{ description: "Fail" }]; }
export async function run() { throw new Error("the door is locked"); }`,
		);
		await writeAction(
			directory,
			"returns_number.mjs",
			`export const timeoutMs = 1000;
export function candidates() { return [{ description: "Number" }]; }
export async function run() { return 42; }`,
		);
		await writeAction(
			directory,
			"silent.mjs",
			`export const timeoutMs = 1000;
export function candidates() { return [{ description: "Silent" }]; }
export async function run() {}`,
		);
		const registry = new CustomActionRegistry(directory);
		await registry.list({});
		const signal = new AbortController().signal;

		await expect(registry.run("fails", null, {}, signal)).rejects.toThrow("the door is locked");
		await expect(registry.run("returns_number", null, {}, signal)).rejects.toThrow(
			"run of returns_number must return a string or nothing",
		);
		await expect(registry.run("silent", null, {}, signal)).resolves.toBeUndefined();
		await expect(registry.run("gone", null, {}, signal)).rejects.toThrow(
			"the action gone is no longer loaded",
		);
	});
});
