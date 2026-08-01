import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_CONFIG } from "../domain/workspace-config";

import { initializeWorkspace } from "./initialize-workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => {
      await rm(path, { force: true, recursive: true });
    }),
  );
});

describe("workspace initializer adapter", () => {
  it("LUNA_HOME 配下の構造と初期ファイルを生成する", async () => {
    const root = await createTemporaryDirectory();
    const templatesDir = await createTemplates(root);
    const lunaHome = resolve(root, "home");

    const initialized = await initializeWorkspace({ lunaHome, templatesDir });

    expect(initialized).toEqual({
      codexHomeDir: resolve(lunaHome, "codex"),
      config: DEFAULT_WORKSPACE_CONFIG,
      configPath: resolve(lunaHome, "config.toml"),
      cronPath: resolve(lunaHome, "workspace", "cron.toml"),
      lunaHomeDir: lunaHome,
      schedule: { jobs: [] },
      workspaceDir: resolve(lunaHome, "workspace"),
    });
    await expect(readFile(resolve(lunaHome, "workspace", "LUNA.md"), "utf8")).resolves.toBe(
      "luna template",
    );
    await expect(readFile(resolve(lunaHome, "workspace", "MEMORY.md"), "utf8")).resolves.toBe(
      "memory template",
    );
    await expect(readFile(resolve(lunaHome, "workspace", "HEARTBEAT.md"), "utf8")).resolves.toBe(
      "heartbeat template",
    );
    await expect(readFile(resolve(lunaHome, "workspace", "cron.toml"), "utf8")).resolves.toBe(
      "jobs = []\n",
    );
  });

  it("既存ファイルを上書きしない", async () => {
    const root = await createTemporaryDirectory();
    const templatesDir = await createTemplates(root);
    const lunaHome = resolve(root, "home");
    const workspaceDir = resolve(lunaHome, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(resolve(workspaceDir, "LUNA.md"), "custom luna");

    await initializeWorkspace({ lunaHome, templatesDir });

    await expect(readFile(resolve(workspaceDir, "LUNA.md"), "utf8")).resolves.toBe("custom luna");
  });

  it("初期文書がすべて存在すればtemplate directoryを要求しない", async () => {
    const root = await createTemporaryDirectory();
    const lunaHome = resolve(root, "home");
    const workspaceDir = resolve(lunaHome, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await Promise.all([
      writeFile(resolve(workspaceDir, "LUNA.md"), "custom luna"),
      writeFile(resolve(workspaceDir, "MEMORY.md"), "custom memory"),
      writeFile(resolve(workspaceDir, "HEARTBEAT.md"), "custom heartbeat"),
    ]);

    await expect(
      initializeWorkspace({ lunaHome, templatesDir: resolve(root, "missing-templates") }),
    ).resolves.toMatchObject({ workspaceDir });
  });

  it.each(["", "   ", "relative/path"])(
    "相対または空の LUNA_HOME %j を拒否する",
    async (lunaHome) => {
      await expect(initializeWorkspace({ lunaHome })).rejects.toThrow(
        "LUNA_HOME must be an absolute path.",
      );
    },
  );

  it("既存 config.toml が不正なら起動に失敗する", async () => {
    const root = await createTemporaryDirectory();
    const templatesDir = await createTemplates(root);
    const lunaHome = resolve(root, "home");
    await mkdir(lunaHome, { recursive: true });
    await writeFile(resolve(lunaHome, "config.toml"), "unknown = true\n");

    await expect(initializeWorkspace({ lunaHome, templatesDir })).rejects.toThrow(
      "workspace initialization failed.",
    );
  });

  it("既存 cron.toml が不正なら起動に失敗する", async () => {
    const root = await createTemporaryDirectory();
    const templatesDir = await createTemplates(root);
    const lunaHome = resolve(root, "home");
    const workspaceDir = resolve(lunaHome, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(resolve(workspaceDir, "cron.toml"), "unknown = true\n");

    await expect(initializeWorkspace({ lunaHome, templatesDir })).rejects.toThrow(
      "workspace initialization failed.",
    );
  });

  it("必要なテンプレートがなければ起動に失敗する", async () => {
    const root = await createTemporaryDirectory();
    const templatesDir = resolve(root, "templates");
    await mkdir(templatesDir);

    await expect(
      initializeWorkspace({ lunaHome: resolve(root, "home"), templatesDir }),
    ).rejects.toThrow("failed to initialize");
  });
});

async function createTemplates(root: string): Promise<string> {
  const templatesDir = resolve(root, "templates");
  await mkdir(templatesDir);
  await Promise.all([
    writeFile(resolve(templatesDir, "LUNA.md"), "luna template"),
    writeFile(resolve(templatesDir, "MEMORY.md"), "memory template"),
    writeFile(resolve(templatesDir, "HEARTBEAT.md"), "heartbeat template"),
  ]);
  return templatesDir;
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "luna-workspace-initialize-"));
  temporaryDirectories.push(directory);
  return directory;
}
