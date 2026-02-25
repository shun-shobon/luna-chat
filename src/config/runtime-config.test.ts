import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRuntimeConfig, RuntimeConfigError } from "./runtime-config";

describe("loadRuntimeConfig", () => {
  it("必須設定のみ読み込む", () => {
    const lunaHomeDir = createTempLunaHomeDir();
    const config = loadRuntimeConfig({
      ALLOWED_CHANNEL_IDS: "111, 222,333",
      LUNA_HOME: lunaHomeDir,
      DISCORD_BOT_TOKEN: "token",
    });

    expect(config.discordBotToken).toBe("token");
    expect(Array.from(config.allowedChannelIds)).toEqual(["111", "222", "333"]);
    expect(config.lunaHomeDir).toBe(resolve(lunaHomeDir));
    expect(config.codexWorkspaceDir).toBe(resolve(lunaHomeDir, "workspace"));
    expect(config.codexHomeDir).toBe(resolve(lunaHomeDir, "codex"));

    rmSync(config.lunaHomeDir, {
      force: true,
      recursive: true,
    });
  });

  it("LUNA_HOME が ~/ 形式ならホーム配下へ展開する", () => {
    const originalHome = process.env["HOME"];
    const testHome = createTempLunaHomeDir();
    mkdirSync(testHome, {
      recursive: true,
    });
    process.env["HOME"] = testHome;

    const relativeLunaHome = `.luna-runtime-config-test-${Date.now()}`;
    try {
      const config = loadRuntimeConfig({
        ALLOWED_CHANNEL_IDS: "111",
        LUNA_HOME: `~/${relativeLunaHome}`,
        DISCORD_BOT_TOKEN: "token",
      });

      expect(config.lunaHomeDir).toBe(resolve(testHome, relativeLunaHome));
      expect(config.codexWorkspaceDir).toBe(resolve(testHome, relativeLunaHome, "workspace"));
      expect(config.codexHomeDir).toBe(resolve(testHome, relativeLunaHome, "codex"));

      rmSync(config.lunaHomeDir, {
        force: true,
        recursive: true,
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = originalHome;
      }
      rmSync(testHome, {
        force: true,
        recursive: true,
      });
    }
  });

  it("workspace と codex ディレクトリを自動作成する", () => {
    const lunaHomeDir = createTempLunaHomeDir();
    const workspaceDir = resolve(lunaHomeDir, "workspace");
    const codexHomeDir = resolve(lunaHomeDir, "codex");
    rmSync(workspaceDir, {
      force: true,
      recursive: true,
    });
    rmSync(codexHomeDir, {
      force: true,
      recursive: true,
    });

    loadRuntimeConfig({
      ALLOWED_CHANNEL_IDS: "111",
      LUNA_HOME: lunaHomeDir,
      DISCORD_BOT_TOKEN: "token",
    });

    expect(existsSync(workspaceDir)).toBe(true);
    expect(existsSync(codexHomeDir)).toBe(true);

    rmSync(lunaHomeDir, {
      force: true,
      recursive: true,
    });
  });

  it("ALLOWED_CHANNEL_IDS が空なら失敗する", () => {
    expect(() =>
      loadRuntimeConfig({
        ALLOWED_CHANNEL_IDS: " ,  ",
        DISCORD_BOT_TOKEN: "token",
      }),
    ).toThrowError(RuntimeConfigError);
  });

  it("DISCORD_BOT_TOKEN がなければ失敗する", () => {
    expect(() =>
      loadRuntimeConfig({
        ALLOWED_CHANNEL_IDS: "111",
      }),
    ).toThrowError(RuntimeConfigError);
  });
});

function createTempLunaHomeDir(): string {
  return resolve(join(tmpdir(), `luna-runtime-config-${Date.now()}-${Math.random().toString(16)}`));
}
