import { describe, expect, it } from "vitest";

import { buildThreadConfig } from "./ai-service";

describe("buildThreadConfig", () => {
  it("uses HTTP MCP server url in thread config", () => {
    const config = buildThreadConfig("medium", "http://127.0.0.1:43123/mcp");

    expect(config).toEqual({
      mcp_servers: {
        discord: {
          url: "http://127.0.0.1:43123/mcp",
        },
      },
      model_reasoning_effort: "medium",
    });
  });
});
