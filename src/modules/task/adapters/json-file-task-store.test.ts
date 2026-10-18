import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Task } from "../domain/task";
import { JsonFileTaskStore } from "./json-file-task-store";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map(async (path) => await rm(path, { force: true, recursive: true })),
	);
});

describe("JsonFileTaskStore", () => {
	it("taskを1件1ファイルで保存し、読み戻す", async () => {
		const directory = await createDirectory();
		const store = new JsonFileTaskStore(directory, vi.fn());

		await store.save(task("task-1"));
		await store.save({ ...task("task-1"), status: "running" });

		expect(await readdir(directory)).toEqual(["task-1.json"]);
		await expect(store.loadAll()).resolves.toEqual([{ ...task("task-1"), status: "running" }]);
	});

	it("壊れたファイルとスキーマ違反を報告して読み飛ばし、json以外は無視する", async () => {
		const directory = await createDirectory();
		const onInvalidFile = vi.fn<(path: string, error: unknown) => void>();
		const store = new JsonFileTaskStore(directory, onInvalidFile);
		await store.save(task("valid"));
		await writeFile(join(directory, "broken.json"), "{");
		await writeFile(join(directory, "invalid.json"), JSON.stringify({ ...task("x"), status: "?" }));
		await writeFile(join(directory, "valid.json.tmp"), "{");

		await expect(store.loadAll()).resolves.toEqual([task("valid")]);
		expect(onInvalidFile.mock.calls.map(([path]) => path)).toEqual([
			join(directory, "broken.json"),
			join(directory, "invalid.json"),
		]);
	});

	it("保存は一時ファイルからのrenameで置き換える", async () => {
		const directory = await createDirectory();
		const store = new JsonFileTaskStore(directory, vi.fn());

		await store.save(task("task-1"));

		expect(JSON.parse(await readFile(join(directory, "task-1.json"), "utf8"))).toEqual(
			task("task-1"),
		);
		expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});

async function createDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "luna-task-store-"));
	directories.push(directory);
	return directory;
}

function task(id: string): Task {
	return {
		version: 1,
		id,
		title: "title",
		instructions: "instructions",
		origin: { kind: "event", eventId: "event-1", eventType: "system.heartbeat.fired.v1" },
		private: true,
		status: "queued",
		attempts: 0,
		createdAt: "2026-10-19T00:00:00.000Z",
		updatedAt: "2026-10-19T00:00:00.000Z",
		reports: [],
		messages: [],
		outcome: null,
	};
}
