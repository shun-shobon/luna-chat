import { describe, expect, it } from "vitest";

import { buildBaseInstructions, buildCodexThreadConfig } from "./thread-input-factory";

describe("thread input factory", () => {
  it("読めたworkspace instructionだけを順番に結合する", () => {
    expect(buildBaseInstructions({ luna: "LUNA", memory: "MEMORY", dailyMemories: [] })).toBe(
      "LUNA\n\nMEMORY",
    );
    expect(buildBaseInstructions({ luna: undefined, memory: "MEMORY", dailyMemories: [] })).toBe(
      "MEMORY",
    );
    expect(buildBaseInstructions({ luna: undefined, memory: undefined, dailyMemories: [] })).toBe(
      "",
    );
  });

  it("日次記憶をpath見出し付きで長期記憶の後ろへ日付順に結合する", () => {
    expect(
      buildBaseInstructions({
        luna: "LUNA",
        memory: undefined,
        dailyMemories: [
          { date: "2026-07-22", content: "yesterday" },
          { date: "2026-07-23", content: "today" },
        ],
      }),
    ).toBe("LUNA\n\n# memory/2026-07-22.md\n\nyesterday\n\n# memory/2026-07-23.md\n\ntoday");
  });

  it("Discord MCPとtrusted workspaceだけをthread configへ入れる", () => {
    expect(
      buildCodexThreadConfig(
        {
          discord: {
            url: "http://127.0.0.1:43123/mcp",
            http_headers: { "X-Luna-Typing-Owner": "owner-1" },
          },
        },
        "/workspace",
      ),
    ).toEqual({
      mcp_servers: {
        discord: {
          url: "http://127.0.0.1:43123/mcp",
          http_headers: { "X-Luna-Typing-Owner": "owner-1" },
        },
      },
      projects: { "/workspace": { trust_level: "trusted" } },
    });
  });
});
