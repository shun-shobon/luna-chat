import { describe, expect, it } from "vitest";

import { loadRuntimeConfig, RuntimeConfigError } from "./runtime-config";

describe("loadRuntimeConfig", () => {
  it("DISCORD_BOT_TOKEN と ALLOWED_CHANNEL_IDS を読み込む", () => {
    const config = loadRuntimeConfig({
      ALLOWED_CHANNEL_IDS: "111, 222,333",
      CODEX_APP_SERVER_COMMAND: "codex-app-server",
      CONTEXT_FETCH_LIMIT: "50",
      DISCORD_BOT_TOKEN: "token",
    });

    expect(config.discordBotToken).toBe("token");
    expect(Array.from(config.allowedChannelIds)).toEqual(["111", "222", "333"]);
    expect(config.contextFetchLimit).toBe(50);
    expect(config.codexAppServerCommand).toBe("codex-app-server");
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

  it("CONTEXT_FETCH_LIMIT が不正なら失敗する", () => {
    expect(() =>
      loadRuntimeConfig({
        ALLOWED_CHANNEL_IDS: "111",
        CONTEXT_FETCH_LIMIT: "0",
        DISCORD_BOT_TOKEN: "token",
      }),
    ).toThrowError(RuntimeConfigError);
  });
});
