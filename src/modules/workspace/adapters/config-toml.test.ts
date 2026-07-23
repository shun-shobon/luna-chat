import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_CONFIG } from "../domain/workspace-config";

import {
  createWorkspaceConfigFile,
  parseWorkspaceConfig,
  readWorkspaceConfig,
  serializeWorkspaceConfig,
} from "./config-toml";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => {
      await rm(path, { force: true, recursive: true });
    }),
  );
});

describe("workspace config TOML", () => {
  it("空の設定には全デフォルト値を補う", () => {
    expect(parseWorkspaceConfig("")).toEqual(DEFAULT_WORKSPACE_CONFIG);
  });

  it("指定値だけを上書きし、未指定フィールドにはデフォルト値を補う", () => {
    expect(
      parseWorkspaceConfig(`
[discord]
allowed_channel_ids = ["123", "456"]
allow_dm = false

[heartbeat]
min_interval_ms = 1000
max_interval_ms = 2000
`),
    ).toEqual({
      ...DEFAULT_WORKSPACE_CONFIG,
      discord: {
        ...DEFAULT_WORKSPACE_CONFIG.discord,
        allowDm: false,
        allowedChannelIds: ["123", "456"],
      },
      heartbeat: {
        ...DEFAULT_WORKSPACE_CONFIG.heartbeat,
        maxIntervalMs: 2_000,
        minIntervalMs: 1_000,
      },
    });
  });

  it.each([
    ["unknown top-level key", "unexpected = true"],
    ["unknown nested key", "[discord]\nunexpected = true"],
    ["non-snowflake channel id", '[discord]\nallowed_channel_ids = ["channel"]'],
    ["heartbeat interval inversion", "[heartbeat]\nmin_interval_ms = 2000\nmax_interval_ms = 1000"],
    [
      "restart delay inversion",
      "[agent]\nrestart_initial_delay_ms = 2000\nrestart_max_delay_ms = 1000",
    ],
    ["negative history limit", "[discord]\ninitial_history_limit = -1"],
    ["zero duration", "[discord]\ndebounce_ms = 0"],
    ["unsafe integer", "[agent]\nrpc_timeout_ms = 9007199254740992"],
  ])("%s を拒否する", (_title, source) => {
    expect(() => parseWorkspaceConfig(source)).toThrow("config.toml is invalid");
  });

  it("全設定を TOML に直列化して往復できる", () => {
    const source = serializeWorkspaceConfig(DEFAULT_WORKSPACE_CONFIG);

    expect(source).toContain("allowed_channel_ids = []");
    expect(source).toContain("thread_retention_ms = 2592000000");
    expect(parseWorkspaceConfig(source)).toEqual(DEFAULT_WORKSPACE_CONFIG);
  });

  it("設定ファイルを排他的に作成し、既存ファイルを上書きしない", async () => {
    const directory = await createTemporaryDirectory();
    const configPath = resolve(directory, "config.toml");

    await createWorkspaceConfigFile(configPath);
    await expect(readWorkspaceConfig(configPath)).resolves.toEqual(DEFAULT_WORKSPACE_CONFIG);
    await expect(createWorkspaceConfigFile(configPath)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(configPath, "utf8")).resolves.toBe(
      serializeWorkspaceConfig(DEFAULT_WORKSPACE_CONFIG),
    );
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "luna-workspace-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
