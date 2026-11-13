import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import type * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import type { Credential } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileCredentialStore } from "./file-credential-store";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof fsPromises>();
	return { ...actual, rename: vi.fn(actual.rename) };
});

function oauth(access: string): Credential {
	return { type: "oauth", access, refresh: "refresh", expires: 1, accountId: "account" };
}

describe("FileCredentialStore", () => {
	let root: string;
	let directory: string;
	let filePath: string;

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "luna-credentials-"));
		directory = path.join(root, "auth");
		filePath = path.join(directory, "credentials.json");
	});

	afterEach(async () => {
		vi.mocked(rename).mockClear();
		await rm(root, { recursive: true, force: true });
	});

	it("ファイルがなければ資格情報なしとして扱う", async () => {
		const store = new FileCredentialStore(filePath);

		await expect(store.read("openai-codex")).resolves.toBeUndefined();
		await expect(store.list()).resolves.toEqual([]);
	});

	it("書き込んだ資格情報を0700のディレクトリと0600のファイルに保存する", async () => {
		const store = new FileCredentialStore(filePath);

		await expect(store.modify("openai-codex", async () => oauth("a1"))).resolves.toEqual(
			oauth("a1"),
		);

		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect((await stat(filePath)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ "openai-codex": oauth("a1") });
		await expect(new FileCredentialStore(filePath).read("openai-codex")).resolves.toEqual(
			oauth("a1"),
		);
		await expect(store.list()).resolves.toEqual([{ providerId: "openai-codex", type: "oauth" }]);
	});

	it("既存ディレクトリの権限も0700に絞る", async () => {
		await mkdir(directory, { mode: 0o755 });
		await chmod(directory, 0o755);

		await new FileCredentialStore(filePath).modify("openai-codex", async () => oauth("a1"));

		expect((await stat(directory)).mode & 0o777).toBe(0o700);
	});

	it("一時ファイルからrenameで置き換え、一時ファイルを残さない", async () => {
		const store = new FileCredentialStore(filePath);
		await store.modify("openai-codex", async () => oauth("a1"));

		await store.modify("openai-codex", async () => oauth("a2"));

		const [from, to] = vi.mocked(rename).mock.calls[1] ?? [];
		expect(path.dirname(String(from))).toBe(directory);
		expect(to).toBe(filePath);
		await expect(readdir(directory)).resolves.toEqual(["credentials.json"]);
	});

	it("置き換えに失敗しても元のファイルを保ち、一時ファイルを消す", async () => {
		const store = new FileCredentialStore(filePath);
		await store.modify("openai-codex", async () => oauth("a1"));
		vi.mocked(rename).mockRejectedValueOnce(new Error("rename failed"));

		await expect(store.modify("openai-codex", async () => oauth("a2"))).rejects.toThrow(
			"rename failed",
		);

		await expect(store.read("openai-codex")).resolves.toEqual(oauth("a1"));
		await expect(readdir(directory)).resolves.toEqual(["credentials.json"]);
	});

	it("壊れたJSONや不正な形のファイルは読み込みも上書きもしない", async () => {
		await mkdir(directory, { recursive: true });
		const store = new FileCredentialStore(filePath);
		const update = vi.fn(async () => oauth("a1"));

		await writeFile(filePath, "{broken");
		await expect(store.read("openai-codex")).rejects.toThrow("not valid JSON");
		await expect(store.modify("openai-codex", update)).rejects.toThrow("not valid JSON");
		expect(update).not.toHaveBeenCalled();
		await expect(readFile(filePath, "utf8")).resolves.toBe("{broken");

		await writeFile(filePath, JSON.stringify({ "openai-codex": { type: "oauth", access: 1 } }));
		await expect(store.list()).rejects.toThrow("invalid shape");
	});

	it("同じプロバイダのmodifyは直列に実行し、前の結果を次に渡す", async () => {
		const store = new FileCredentialStore(filePath);
		let running = 0;
		let maxRunning = 0;

		await Promise.all(
			Array.from({ length: 10 }, () =>
				store.modify("openai-codex", async (current) => {
					running += 1;
					maxRunning = Math.max(maxRunning, running);
					await setTimeout(1);
					running -= 1;
					const count = current?.type === "oauth" ? Number(current.access) : 0;
					return oauth(String(count + 1));
				}),
			),
		);

		expect(maxRunning).toBe(1);
		await expect(store.read("openai-codex")).resolves.toEqual(oauth("10"));
	});

	it("別プロバイダのmodifyが並行しても互いの書き込みを消さない", async () => {
		const store = new FileCredentialStore(filePath);

		await Promise.all(
			["a", "b", "c", "d"].map((providerId) =>
				store.modify(providerId, async () => oauth(providerId)),
			),
		);

		await expect(store.list()).resolves.toHaveLength(4);
		await expect(store.read("c")).resolves.toEqual(oauth("c"));
	});

	it("undefinedを返すと変更せず、例外は呼び出し元へ返して後続を止めない", async () => {
		const store = new FileCredentialStore(filePath);
		await store.modify("openai-codex", async () => oauth("a1"));

		await expect(store.modify("openai-codex", async () => undefined)).resolves.toEqual(oauth("a1"));
		await expect(
			store.modify("openai-codex", async () => {
				throw new Error("refresh failed");
			}),
		).rejects.toThrow("refresh failed");
		await expect(store.modify("openai-codex", async () => oauth("a2"))).resolves.toEqual(
			oauth("a2"),
		);
	});

	it("deleteで資格情報を消す", async () => {
		const store = new FileCredentialStore(filePath);
		await store.modify("openai-codex", async () => oauth("a1"));
		await store.modify("other", async () => oauth("b1"));

		await store.delete("openai-codex");

		await expect(store.read("openai-codex")).resolves.toBeUndefined();
		await expect(store.read("other")).resolves.toEqual(oauth("b1"));
	});

	it("中断済みのsignalではmodifyを実行しない", async () => {
		const store = new FileCredentialStore(filePath);
		const update = vi.fn(async () => oauth("a1"));
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));

		await expect(
			store.modify("openai-codex", update, { signal: controller.signal }),
		).rejects.toThrow("cancelled");
		expect(update).not.toHaveBeenCalled();
		await expect(store.read("openai-codex")).resolves.toBeUndefined();
	});
});
