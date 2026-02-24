import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRuntimeConfig, RuntimeConfigError } from "./runtime-config";

describe("loadRuntimeConfig", () => {
  it("必須設定のみ読み込む", () => {
    const artemisHomeDir = createTempArtemisHomeDir();
    const config = loadRuntimeConfig({
      ALLOWED_CHANNEL_IDS: "111, 222,333",
      ARTEMIS_HOME: artemisHomeDir,
      DISCORD_BOT_TOKEN: "token",
    });

    expect(config.discordBotToken).toBe("token");
    expect(Array.from(config.allowedChannelIds)).toEqual(["111", "222", "333"]);
    expect(config.artemisHomeDir).toBe(resolve(artemisHomeDir));
    expect(config.codexWorkspaceDir).toBe(resolve(artemisHomeDir, "workspace"));
    expect(config.codexHomeDir).toBe(resolve(artemisHomeDir, "codex"));

    rmSync(config.artemisHomeDir, {
      force: true,
      recursive: true,
    });
  });

  it("ARTEMIS_HOME が ~/ 形式ならホーム配下へ展開する", () => {
    const originalHome = process.env["HOME"];
    const testHome = createTempArtemisHomeDir();
    mkdirSync(testHome, {
      recursive: true,
    });
    process.env["HOME"] = testHome;

    const relativeArtemisHome = `.artemis-runtime-config-test-${Date.now()}`;
    try {
      const config = loadRuntimeConfig({
        ALLOWED_CHANNEL_IDS: "111",
        ARTEMIS_HOME: `~/${relativeArtemisHome}`,
        DISCORD_BOT_TOKEN: "token",
      });

      expect(config.artemisHomeDir).toBe(resolve(testHome, relativeArtemisHome));
      expect(config.codexWorkspaceDir).toBe(resolve(testHome, relativeArtemisHome, "workspace"));
      expect(config.codexHomeDir).toBe(resolve(testHome, relativeArtemisHome, "codex"));

      rmSync(config.artemisHomeDir, {
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
    const artemisHomeDir = createTempArtemisHomeDir();
    const workspaceDir = resolve(artemisHomeDir, "workspace");
    const codexHomeDir = resolve(artemisHomeDir, "codex");
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
      ARTEMIS_HOME: artemisHomeDir,
      DISCORD_BOT_TOKEN: "token",
    });

    expect(existsSync(workspaceDir)).toBe(true);
    expect(existsSync(codexHomeDir)).toBe(true);

    rmSync(artemisHomeDir, {
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

function createTempArtemisHomeDir(): string {
  return resolve(
    join(tmpdir(), `artemis-runtime-config-${Date.now()}-${Math.random().toString(16)}`),
  );
}
