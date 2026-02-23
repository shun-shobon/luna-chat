import { afterEach, describe, expect, it } from "vitest";

import { DISCORD_MCP_PATH, startDiscordMcpServer } from "./discord-mcp-server";

const startedServers: Array<{ close: () => Promise<void>; url: string }> = [];

afterEach(async () => {
  for (const server of startedServers.splice(0)) {
    await server.close();
  }
});

describe("startDiscordMcpServer", () => {
  it("throws when token is empty", async () => {
    await expect(
      startDiscordMcpServer({
        token: "   ",
      }),
    ).rejects.toThrow("DISCORD_BOT_TOKEN is required");
  });

  it("starts server and returns /mcp url", async () => {
    const server = await startDiscordMcpServer({
      token: "dummy-token",
    });
    startedServers.push(server);

    const url = new URL(server.url);
    expect(url.protocol).toBe("http:");
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe(DISCORD_MCP_PATH);
    expect(Number(url.port)).toBeGreaterThan(0);
  });
});
