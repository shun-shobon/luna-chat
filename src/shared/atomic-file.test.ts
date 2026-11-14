import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeFileAtomic, writeFileAtomicSync } from "./atomic-file";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

async function createDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "luna-atomic-file-"));
	directories.push(directory);
	return directory;
}

describe("writeFileAtomic", () => {
	it("既存のファイルを置き換え、一時ファイルを残さない", async () => {
		const directory = await createDirectory();
		const path = join(directory, "state.json");
		await writeFile(path, "old");

		await writeFileAtomic(path, "new");

		expect(await readFile(path, "utf8")).toBe("new");
		expect(await readdir(directory)).toEqual(["state.json"]);
	});

	it("指定したmodeをumaskに関係なく付ける", async () => {
		const directory = await createDirectory();
		const path = join(directory, "secret.json");

		await writeFileAtomic(path, "{}", { mode: 0o600 });

		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("置き換えに失敗したら一時ファイルを消して失敗を返す", async () => {
		const directory = await createDirectory();
		const path = join(directory, "target");
		await createNonEmptyDirectory(path);

		await expect(writeFileAtomic(path, "data")).rejects.toThrow(/EISDIR|ENOTEMPTY/u);
		expect(await readdir(directory)).toEqual(["target"]);
	});
});

describe("writeFileAtomicSync", () => {
	it("既存のファイルを置き換え、一時ファイルを残さない", async () => {
		const directory = await createDirectory();
		const path = join(directory, "cron.toml");
		await writeFile(path, "old");

		writeFileAtomicSync(path, "new");

		expect(await readFile(path, "utf8")).toBe("new");
		expect(await readdir(directory)).toEqual(["cron.toml"]);
	});

	it("置き換えに失敗したら一時ファイルを消して失敗を返す", async () => {
		const directory = await createDirectory();
		const path = join(directory, "target");
		await createNonEmptyDirectory(path);

		expect(() => writeFileAtomicSync(path, "data")).toThrow(/EISDIR|ENOTEMPTY/u);
		expect(await readdir(directory)).toEqual(["target"]);
	});
});

// 中身のあるディレクトリへのファイルの rename は失敗する。
async function createNonEmptyDirectory(path: string): Promise<void> {
	await mkdir(path);
	await writeFile(join(path, "child"), "");
}
