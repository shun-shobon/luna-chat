import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readHeartbeatChecklist, readWorkspaceBaseInstructions } from "./workspace-instructions";

const temporaryDirectories: string[] = [];
const now = new Date(2026, 6, 23, 12);

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

    await expect(readWorkspaceBaseInstructions(workspaceDir, now)).resolves.toEqual({
      luna: "luna body",
      memory: "memory body",
      dailyMemories: [],
    });
  });

  it("LUNA.md または MEMORY.md が読めなくても読める側だけで継続する", async () => {
    const workspaceDir = await createTemporaryDirectory();
    await writeFile(resolve(workspaceDir, "MEMORY.md"), "memory body");

    await expect(readWorkspaceBaseInstructions(workspaceDir, now)).resolves.toEqual({
      luna: undefined,
      memory: "memory body",
      dailyMemories: [],
    });
  });

  it("local dateの前日と当日の日次記憶だけを古い順に読む", async () => {
    const workspaceDir = await createTemporaryDirectory();
    await mkdir(resolve(workspaceDir, "memory"));
    await Promise.all([
      writeFile(resolve(workspaceDir, "memory", "2026-06-30.md"), "older"),
      writeFile(resolve(workspaceDir, "memory", "2026-07-01.md"), "yesterday"),
      writeFile(resolve(workspaceDir, "memory", "2026-07-02.md"), "today"),
    ]);

    await expect(
      readWorkspaceBaseInstructions(workspaceDir, new Date(2026, 6, 2, 0, 30)),
    ).resolves.toMatchObject({
      dailyMemories: [
        { date: "2026-07-01", content: "yesterday" },
        { date: "2026-07-02", content: "today" },
      ],
    });
    await expect(
      readWorkspaceBaseInstructions(workspaceDir, new Date(2026, 6, 3, 23, 59)),
    ).resolves.toMatchObject({
      dailyMemories: [{ date: "2026-07-02", content: "today" }],
    });
  });

  it("HEARTBEAT.md の全文を読み、読めなければ失敗する", async () => {
    const workspaceDir = await createTemporaryDirectory();
    const heartbeatPath = resolve(workspaceDir, "HEARTBEAT.md");
    await writeFile(heartbeatPath, "heartbeat body");

    await expect(readHeartbeatChecklist(workspaceDir)).resolves.toBe("heartbeat body");
    await rm(heartbeatPath);
    await expect(readHeartbeatChecklist(workspaceDir)).rejects.toThrow(
      "HEARTBEAT.md must be readable.",
    );
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "luna-workspace-instructions-"));
  temporaryDirectories.push(directory);
  return directory;
}
