import { describe, expect, it } from "vitest";

import { readRuntimeEnvironment } from "./runtime-environment";

describe("readRuntimeEnvironment", () => {
  it("必須tokenと明示値を検証する", () => {
    expect(
      readRuntimeEnvironment({
        DISCORD_BOT_TOKEN: "token",
        LOG_LEVEL: "debug",
        LUNA_HOME: "/var/lib/luna",
        UNRELATED: "preserved outside this parser",
      }),
    ).toEqual({ discordBotToken: "token", logLevel: "debug", lunaHome: "/var/lib/luna" });
  });

  it("LOG_LEVELだけに明示既定値を適用する", () => {
    expect(readRuntimeEnvironment({ DISCORD_BOT_TOKEN: "token" })).toEqual({
      discordBotToken: "token",
      logLevel: "info",
    });
  });

  it("空白tokenと不正levelを拒否する", () => {
    expect(() => readRuntimeEnvironment({ DISCORD_BOT_TOKEN: "  " })).toThrow();
    expect(() =>
      readRuntimeEnvironment({ DISCORD_BOT_TOKEN: "token", LOG_LEVEL: "verbose" }),
    ).toThrow();
  });
});
