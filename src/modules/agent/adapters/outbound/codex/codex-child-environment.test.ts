import { describe, expect, it } from "vitest";

import { createCodexChildEnvironment } from "./codex-child-environment";

describe("codex child environment", () => {
  it("child environment から Discord token を除去して CODEX_HOME を固定する", () => {
    expect(
      createCodexChildEnvironment(
        { CODEX_HOME: "/old", DISCORD_BOT_TOKEN: "secret", KEEP_ME: "value" },
        "/codex-home",
      ),
    ).toEqual({ CODEX_HOME: "/codex-home", KEEP_ME: "value" });
  });
});
