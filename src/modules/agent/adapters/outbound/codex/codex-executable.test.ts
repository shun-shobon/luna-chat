import { describe, expect, it } from "vitest";

import { createCodexChildEnvironment, resolveCodexExecutable } from "./codex-executable";

describe("codex executable", () => {
  it("固定 package の executable を absolute realpath に解決する", () => {
    const moduleIds: string[] = [];
    const result = resolveCodexExecutable({
      realpath: (path) => `/real${path}`,
      resolveModule: (moduleId) => {
        moduleIds.push(moduleId);
        return "/package/bin/codex.js";
      },
    });

    expect(result).toBe("/real/package/bin/codex.js");
    expect(moduleIds).toEqual(["@openai/codex/bin/codex.js"]);
  });

  it("child environment から Discord token を除去して CODEX_HOME を固定する", () => {
    expect(
      createCodexChildEnvironment(
        { CODEX_HOME: "/old", DISCORD_BOT_TOKEN: "secret", KEEP_ME: "value" },
        "/codex-home",
      ),
    ).toEqual({ CODEX_HOME: "/codex-home", KEEP_ME: "value" });
  });
});
