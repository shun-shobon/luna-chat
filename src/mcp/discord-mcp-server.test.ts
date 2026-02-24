import type { REST } from "discord.js";
import { Routes } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { addMessageReaction, DISCORD_MCP_PATH, startDiscordMcpServer } from "./discord-mcp-server";

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

describe("addMessageReaction", () => {
  it("throws when emoji is blank", async () => {
    await expect(
      addMessageReaction(createRestClientStub(), {
        channelId: "channel-id",
        emoji: "   ",
        messageId: "message-id",
      }),
    ).rejects.toThrow("emoji must not be empty.");
  });

  it("adds reaction with unicode emoji", async () => {
    const rest = createRestClientStub();

    await expect(
      addMessageReaction(rest, {
        channelId: "channel-id",
        emoji: "😄",
        messageId: "message-id",
      }),
    ).resolves.toEqual({ ok: true });

    expect(rest.put).toHaveBeenCalledWith(
      Routes.channelMessageOwnReaction("channel-id", "message-id", "😄"),
    );
  });

  it("adds reaction with custom emoji", async () => {
    const rest = createRestClientStub();

    await addMessageReaction(rest, {
      channelId: "channel-id",
      emoji: "party:987654321",
      messageId: "message-id",
    });

    expect(rest.put).toHaveBeenCalledWith(
      Routes.channelMessageOwnReaction("channel-id", "message-id", "party:987654321"),
    );
  });
});

function createRestClientStub() {
  const put = vi.fn(async () => {});
  return {
    put,
  } satisfies Pick<REST, "put">;
}
