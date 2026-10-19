import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readHeartbeatContext, readWorkspaceBaseInstructions } from "./workspace-instructions";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (path) => {
			await rm(path, { force: true, recursive: true });
		}),
	);
});

describe("workspace instructions", () => {
	it("LUNA.md と MEMORY.md の全文を読む", async () => {
		const workspaceDir = await createTemporaryDirectory();
		await Promise.all([
			writeFile(resolve(workspaceDir, "LUNA.md"), "luna body"),
			writeFile(resolve(workspaceDir, "MEMORY.md"), "memory body"),
		]);

		await expect(readWorkspaceBaseInstructions(workspaceDir)).resolves.toEqual({
			luna: "luna body",
			memory: "memory body",
		});
	});

	it("LUNA.md または MEMORY.md が読めなくても読める側だけで継続する", async () => {
		const workspaceDir = await createTemporaryDirectory();
		await writeFile(resolve(workspaceDir, "MEMORY.md"), "memory body");

		await expect(readWorkspaceBaseInstructions(workspaceDir)).resolves.toEqual({
			luna: undefined,
			memory: "memory body",
		});
	});

	it("日次記憶はベースインストラクションに含めない", async () => {
		const workspaceDir = await createTemporaryDirectory();
		await mkdir(resolve(workspaceDir, "memory"));
		await writeFile(resolve(workspaceDir, "memory", "2026-07-02.md"), "today");

		await expect(readWorkspaceBaseInstructions(workspaceDir)).resolves.toEqual({
			luna: undefined,
			memory: undefined,
		});
	});

	it("HEARTBEAT.md と AGENDA.md の全文を読み、どちらかが読めなければ失敗する", async () => {
		const workspaceDir = await createTemporaryDirectory();
		const heartbeatPath = resolve(workspaceDir, "HEARTBEAT.md");
		const agendaPath = resolve(workspaceDir, "AGENDA.md");
		await Promise.all([
			writeFile(heartbeatPath, "heartbeat body"),
			writeFile(agendaPath, "agenda body"),
		]);

		await expect(readHeartbeatContext(workspaceDir)).resolves.toEqual({
			checklist: "heartbeat body",
			agenda: "agenda body",
		});
		await rm(agendaPath);
		await expect(readHeartbeatContext(workspaceDir)).rejects.toThrow("AGENDA.md must be readable.");
		await rm(heartbeatPath);
		await expect(readHeartbeatContext(workspaceDir)).rejects.toThrow(
			"HEARTBEAT.md must be readable.",
		);
	});
});

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "luna-workspace-instructions-"));
	temporaryDirectories.push(directory);
	return directory;
}
