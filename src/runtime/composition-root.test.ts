import { describe, expect, it, vi } from "vitest";

import { shutdownApplication } from "./composition-root";

describe("application composition lifecycle", () => {
  it("一つのcleanup失敗後も全resourceを停止して失敗を返す", async () => {
    const calls: string[] = [];
    const failure = new Error("MCP close failed");
    const shutdown = shutdownApplication({
      automation: {
        stopIntake: vi.fn(async () => {
          calls.push("automation.stopIntake");
        }),
        drain: vi.fn(async () => {
          calls.push("automation.drain");
        }),
      },
      clientDestroy: async () => {
        calls.push("client.destroy");
      },
      conversation: {
        stopIntake: vi.fn(() => {
          calls.push("conversation.stopIntake");
        }),
        drain: vi.fn(async () => {
          calls.push("conversation.drain");
        }),
        abort: vi.fn(async () => {
          calls.push("conversation.abort");
        }),
      },
      gateway: {
        stop: vi.fn(() => {
          calls.push("gateway.stop");
        }),
      },
      isFatal: false,
      logger: { flush: vi.fn(async () => undefined), log: vi.fn() },
      mcpClose: async () => {
        calls.push("mcp.close");
        throw failure;
      },
      supervisorClose: async () => {
        calls.push("supervisor.close");
      },
      typingRelease: () => {
        calls.push("typing.release");
      },
    });

    await expect(shutdown).rejects.toThrow("Application shutdown failed");
    expect(calls).toEqual(
      expect.arrayContaining([
        "gateway.stop",
        "conversation.stopIntake",
        "automation.stopIntake",
        "conversation.drain",
        "automation.drain",
        "typing.release",
        "mcp.close",
        "client.destroy",
        "supervisor.close",
      ]),
    );
    expect(calls).not.toContain("conversation.abort");
  });
});
