import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceTrash } from "./workspace-trash";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

async function setup(folders: Readonly<Record<string, readonly string[]>>) {
	const workspace = await mkdtemp(join(tmpdir(), "luna-trash-"));
	directories.push(workspace);
	for (const [folder, entries] of Object.entries(folders)) {
		await mkdir(join(workspace, ".trash", folder), { recursive: true });
		for (const entry of entries) await writeFile(join(workspace, ".trash", folder, entry), "x");
	}
	const log = vi.fn();
	return { trash: new WorkspaceTrash(workspace, { log }), workspace, log };
}

describe("WorkspaceTrash", () => {
	it("捨てた日から14日経った日付フォルダだけを消し、日付でない名前は記録して残す", async () => {
		const { trash, workspace, log } = await setup({
			"2026-10-31": ["old.txt"],
			"2026-11-01": ["recent.txt"],
			misc: ["unknown.txt"],
		});

		await trash.prune(new Date("2026-11-14T12:00:00"));

		expect((await readdir(join(workspace, ".trash"))).toSorted()).toEqual(["2026-11-01", "misc"]);
		expect(log).toHaveBeenCalledWith("warn", "workspace.trash.unknown_entry", undefined, {
			name: "misc",
		});
		expect(log).toHaveBeenCalledWith("info", "workspace.trash.deleted", undefined, {
			folder: "2026-10-31",
		});
	});

	it("ゴミ箱がなければ何もせず、状態は空にする", async () => {
		const { trash } = await setup({});

		await expect(trash.prune(new Date())).resolves.toBeUndefined();
		expect(trash.status().trash).toEqual([]);
	});

	it("日付フォルダごとに削除日と中身を返し、ディスクの容量も返す", async () => {
		const { trash } = await setup({ "2026-11-14": ["b", "a"], misc: ["c"] });

		const status = trash.status();

		expect(status.trash).toEqual([
			{ date: "2026-11-14", deleteOn: "2026-11-28", entries: ["a", "b"] },
		]);
		expect(status.disk.totalBytes).toBeGreaterThan(status.disk.freeBytes);
	});
});
