import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { pruneTranscripts, TranscriptWriter } from "./pi-transcript";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-11-14T12:00:00+09:00");
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function createRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "pi-transcript-"));
	temporaryDirectories.push(root);
	return root;
}

async function createFile(
	root: string,
	directory: string,
	name: string,
	modifiedAt: Date,
): Promise<string> {
	const filePath = path.join(root, directory, name);
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, "{}\n");
	await utimes(filePath, modifiedAt, modifiedAt);
	return filePath;
}

describe("pruneTranscripts", () => {
	it("保持期間より前に更新された記録を消し、空になった日付ディレクトリも消す", async () => {
		const root = await createRoot();
		await createFile(root, "2026-11-01", "old.jsonl", new Date(NOW.getTime() - 10 * DAY_MS));
		await createFile(root, "2026-11-05", "old.jsonl", new Date(NOW.getTime() - 8 * DAY_MS));
		// 開いた日は古くても、追記が続いているセッションは残す。
		await createFile(root, "2026-11-05", "active.jsonl", new Date(NOW.getTime() - DAY_MS));
		await createFile(root, "2026-11-13", "new.jsonl", new Date(NOW.getTime() - DAY_MS));
		await createFile(root, "not-a-date", "old.jsonl", new Date(NOW.getTime() - 10 * DAY_MS));

		const removed = await pruneTranscripts(root, NOW, 7 * DAY_MS);

		expect(removed).toBe(2);
		expect((await readdir(root)).toSorted()).toEqual(["2026-11-05", "2026-11-13", "not-a-date"]);
		expect(await readdir(path.join(root, "2026-11-05"))).toEqual(["active.jsonl"]);
	});

	it("記録のディレクトリがまだなければ何もしない", async () => {
		const root = await createRoot();

		await expect(pruneTranscripts(path.join(root, "missing"), NOW, DAY_MS)).resolves.toBe(0);
	});
});

describe("TranscriptWriter", () => {
	it("消された日付ディレクトリを作り直して追記を続ける", async () => {
		const root = await createRoot();
		const filePath = path.join(root, "2026-11-14", "session.jsonl");
		const logger = { log: vi.fn() };
		const writer = new TranscriptWriter({ filePath, logger, sessionId: "session" });

		writer.append({ type: "a" });
		await writer.flush();
		await rm(path.dirname(filePath), { recursive: true });
		writer.append({ type: "b" });
		await writer.flush();

		expect(await readFile(filePath, "utf8")).toBe('{"type":"b"}\n');
		expect(logger.log).not.toHaveBeenCalled();
	});

	it("書き込みに失敗してもログに残して後続を止めない", async () => {
		const root = await createRoot();
		const blocker = path.join(root, "blocker");
		await writeFile(blocker, "");
		const logger = { log: vi.fn() };
		const writer = new TranscriptWriter({
			filePath: path.join(blocker, "session.jsonl"),
			logger,
			sessionId: "session",
		});

		writer.append({ type: "a" });
		await writer.flush();

		expect(logger.log).toHaveBeenCalledWith(
			"error",
			"agent.pi.transcript_write_failed",
			undefined,
			expect.objectContaining({ sessionId: "session" }),
		);
	});
});
