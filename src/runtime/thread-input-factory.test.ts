import { describe, expect, it } from "vitest";

import { buildBaseInstructions, buildCodexThreadConfig } from "./thread-input-factory";

describe("thread input factory", () => {
  it("読めたworkspace instructionだけを順番に結合する", () => {
    expect(buildBaseInstructions({ luna: "LUNA", memory: "MEMORY" })).toBe("LUNA\n\nMEMORY");
    expect(buildBaseInstructions({ luna: undefined, memory: "MEMORY" })).toBe("MEMORY");
    expect(buildBaseInstructions({ luna: undefined, memory: undefined })).toBe("");
  });

  it("Discord MCPとtrusted workspaceだけをthread configへ入れる", () => {
    expect(buildCodexThreadConfig("http://127.0.0.1:43123/mcp", "/workspace", "owner-1")).toEqual({
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
