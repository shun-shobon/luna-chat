import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRuntimeConfig, RuntimeConfigError } from "./runtime-config";

describe("loadRuntimeConfig", () => {
  it("必須設定のみ読み込む", () => {
    const config = loadRuntimeConfig({
      ALLOWED_CHANNEL_IDS: "111, 222,333",
      DISCORD_BOT_TOKEN: "token",
    });

    expect(config.discordBotToken).toBe("token");
    expect(Array.from(config.allowedChannelIds)).toEqual(["111", "222", "333"]);
    expect(config.codexWorkspaceDir).toBe(resolve(process.cwd(), "codex-workspace"));
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
