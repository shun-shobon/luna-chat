import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveDiscordSendFilePaths } from "./resolve-discord-send-file-paths";

const workspaceDirs: string[] = [];

afterEach(async () => {
  for (const workspaceDir of workspaceDirs.splice(0)) {
    await removeDirectory(workspaceDir);
  }
});

describe("resolveDiscordSendFilePaths", () => {
  it("未指定時は undefined を返す", async () => {
    await expect(
      resolveDiscordSendFilePaths({
        workspaceDir: "/tmp/workspace",
      }),
    ).resolves.toBeUndefined();
  });

  it("相対パスを workspace 基準の絶対パスへ解決する", async () => {
    const workspaceDir = await createWorkspaceDir();
    await mkdir(resolve(workspaceDir, "nested"), { recursive: true });
    await writeFile(resolve(workspaceDir, "nested", "a.txt"), "A");
    await writeFile(resolve(workspaceDir, "b.txt"), "B");

    await expect(
      resolveDiscordSendFilePaths({
        filePaths: ["nested/a.txt", "./b.txt"],
        workspaceDir,
      }),
    ).resolves.toEqual([resolve(workspaceDir, "nested", "a.txt"), resolve(workspaceDir, "b.txt")]);
  });

  it("絶対パスをそのまま許可する", async () => {
    const workspaceDir = await createWorkspaceDir();
    const outsideDir = await createWorkspaceDir("luna-send-absolute-");
    const absoluteFilePath = resolve(outsideDir, "file.txt");
    await writeFile(absoluteFilePath, "content");

    await expect(
      resolveDiscordSendFilePaths({
        filePaths: [absoluteFilePath],
        workspaceDir,
      }),
    ).resolves.toEqual([absoluteFilePath]);
  });

  it("workspace 外へ出る相対パスを拒否する", async () => {
    const workspaceDir = await createWorkspaceDir();

    await expect(
      resolveDiscordSendFilePaths({
        filePaths: ["../outside.txt"],
        workspaceDir,
      }),
    ).rejects.toThrow("filePaths[0] must stay within the workspace when using a relative path.");
  });

  it("存在しないパスを拒否する", async () => {
    const workspaceDir = await createWorkspaceDir();

    await expect(
      resolveDiscordSendFilePaths({
        filePaths: ["missing.txt"],
        workspaceDir,
      }),
    ).rejects.toThrow("filePaths[0] must reference a readable file.");
  });

  it("ディレクトリを拒否する", async () => {
    const workspaceDir = await createWorkspaceDir();
    await mkdir(resolve(workspaceDir, "dir"), { recursive: true });

    await expect(
      resolveDiscordSendFilePaths({
        filePaths: ["dir"],
        workspaceDir,
      }),
    ).rejects.toThrow("filePaths[0] must reference a readable file.");
  });

  it("不可読ファイルを拒否する", async () => {
    const workspaceDir = await createWorkspaceDir();
    const filePath = resolve(workspaceDir, "private.txt");
    await writeFile(filePath, "secret");
    await chmod(filePath, 0o000);

    try {
      await expect(
        resolveDiscordSendFilePaths({
          filePaths: ["private.txt"],
          workspaceDir,
        }),
      ).rejects.toThrow("filePaths[0] must reference a readable file.");
    } finally {
      await chmod(filePath, 0o644);
    }
  });
});

async function createWorkspaceDir(prefix = "luna-send-file-paths-"): Promise<string> {
  const workspaceDir = await mkdtemp(join(tmpdir(), prefix));
  workspaceDirs.push(workspaceDir);
  return workspaceDir;
}

async function removeDirectory(path: string): Promise<void> {
  await rm(path, {
    force: true,
    recursive: true,
  });
}
