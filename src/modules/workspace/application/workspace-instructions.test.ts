import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readHeartbeatChecklist, readWorkspaceBaseInstructions } from "./workspace-instructions";

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
