import { access, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRuntimeConfig, RuntimeConfigError } from "./runtime-config";

describe("loadRuntimeConfig", () => {
  it("必須設定のみ読み込む", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    const config = await loadRuntimeConfig({
      ALLOWED_CHANNEL_IDS: "111, 222,333",
      LUNA_HOME: lunaHomeDir,
      DISCORD_BOT_TOKEN: "token",
    });

    expect(config.discordBotToken).toBe("token");
    expect(Array.from(config.allowedChannelIds)).toEqual(["111", "222", "333"]);
    expect(config.lunaHomeDir).toBe(resolve(lunaHomeDir));
    expect(config.codexWorkspaceDir).toBe(resolve(lunaHomeDir, "workspace"));
    expect(config.codexHomeDir).toBe(resolve(lunaHomeDir, "codex"));
    expect(config.logsDir).toBe(resolve(lunaHomeDir, "logs"));

    await rm(config.lunaHomeDir, {
      force: true,
      recursive: true,
    });
  });

  it("LUNA_HOME が ~/ 形式ならホーム配下へ展開する", async () => {
    const originalHome = process.env["HOME"];
    const testHome = createTempLunaHomeDir();
    await mkdir(testHome, {
      recursive: true,
    });
    process.env["HOME"] = testHome;

    const relativeLunaHome = `.luna-runtime-config-test-${Date.now()}`;
    try {
      const config = await loadRuntimeConfig({
        ALLOWED_CHANNEL_IDS: "111",
        LUNA_HOME: `~/${relativeLunaHome}`,
        DISCORD_BOT_TOKEN: "token",
      });

      expect(config.lunaHomeDir).toBe(resolve(testHome, relativeLunaHome));
      expect(config.codexWorkspaceDir).toBe(resolve(testHome, relativeLunaHome, "workspace"));
      expect(config.codexHomeDir).toBe(resolve(testHome, relativeLunaHome, "codex"));
      expect(config.logsDir).toBe(resolve(testHome, relativeLunaHome, "logs"));

      await rm(config.lunaHomeDir, {
        force: true,
        recursive: true,
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = originalHome;
      }
      await rm(testHome, {
        force: true,
        recursive: true,
      });
    }
  });

  it("workspace と codex と logs ディレクトリを自動作成する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    const workspaceDir = resolve(lunaHomeDir, "workspace");
    const codexHomeDir = resolve(lunaHomeDir, "codex");
    const logsDir = resolve(lunaHomeDir, "logs");
    await rm(workspaceDir, {
      force: true,
      recursive: true,
    });
    await rm(codexHomeDir, {
      force: true,
      recursive: true,
    });
    await rm(logsDir, {
      force: true,
      recursive: true,
    });

    await loadRuntimeConfig({
      ALLOWED_CHANNEL_IDS: "111",
      LUNA_HOME: lunaHomeDir,
      DISCORD_BOT_TOKEN: "token",
    });

    expect(await exists(workspaceDir)).toBe(true);
    expect(await exists(codexHomeDir)).toBe(true);
    expect(await exists(logsDir)).toBe(true);

    await rm(lunaHomeDir, {
      force: true,
      recursive: true,
    });
  });

  it("ALLOWED_CHANNEL_IDS が空なら失敗する", async () => {
    await expect(
      loadRuntimeConfig({
        ALLOWED_CHANNEL_IDS: " ,  ",
        DISCORD_BOT_TOKEN: "token",
      }),
    ).rejects.toThrowError(RuntimeConfigError);
  });

  it("DISCORD_BOT_TOKEN がなければ失敗する", async () => {
    await expect(
      loadRuntimeConfig({
        ALLOWED_CHANNEL_IDS: "111",
      }),
    ).rejects.toThrowError(RuntimeConfigError);
  });
});

function createTempLunaHomeDir(): string {
  return resolve(join(tmpdir(), `luna-runtime-config-${Date.now()}-${Math.random().toString(16)}`));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
