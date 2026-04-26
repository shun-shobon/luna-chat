import { afterEach, describe, expect, it, vi } from "vitest";

import { startDiscordMcpServer } from "./discord-mcp-http-server";

const startedServers: Array<{ close: () => Promise<void>; url: string }> = [];

afterEach(async () => {
  for (const server of startedServers.splice(0)) {
    await server.close();
  }
});

describe("startDiscordMcpServer", () => {
  it("starts server and returns /mcp url", async () => {
    const server = await startDiscordMcpServer({
      allowedChannelIds: new Set(["channel-id"]),
      client: createDiscordClientStub(),
      workspaceDir: "/tmp/workspace",
    });
    startedServers.push(server);

    const url = new URL(server.url);
    expect(url.protocol).toBe("http:");
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe("/mcp");
    expect(Number(url.port)).toBeGreaterThan(0);
  });
});

function createDiscordClientStub() {
  return {
    channels: {
      fetch: vi.fn(async () => null),
    },
    guilds: {
      fetch: vi.fn(async () => null),
    },
    users: {
      createDM: vi.fn(async () => ({
        id: "dm-channel-id",
      })),
      fetch: vi.fn(async () => null),
    },
  };
}
