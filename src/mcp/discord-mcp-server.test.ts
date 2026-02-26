import type { REST } from "discord.js";
import { Routes } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiscordAttachmentStore } from "../attachments/discord-attachment-store";

import {
  addMessageReaction,
  DISCORD_MCP_PATH,
  startDiscordMcpServer,
  startTypingLoop,
  stopAllTypingLoops,
  stopTypingLoop,
} from "./discord-mcp-server";

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
        attachmentStore: createAttachmentStoreStub(),
        token: "   ",
      }),
    ).rejects.toThrow("DISCORD_BOT_TOKEN is required");
  });

  it("starts server and returns /mcp url", async () => {
    const server = await startDiscordMcpServer({
      attachmentStore: createAttachmentStoreStub(),
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

describe("typing loop helpers", () => {
  it("starts typing immediately and repeats periodically", async () => {
    vi.useFakeTimers();
    try {
      const rest = createTypingRestClientStub();
      const activeTypingLoops = new Map<string, ReturnType<typeof setInterval>>();

      await expect(
        startTypingLoop({
          activeTypingLoops,
          channelId: "channel-1",
          rest,
        }),
      ).resolves.toEqual({
        alreadyRunning: false,
        ok: true,
      });
      expect(rest.post).toHaveBeenCalledTimes(1);
      expect(rest.post).toHaveBeenCalledWith(Routes.channelTyping("channel-1"));

      await vi.advanceTimersByTimeAsync(8_000);
      expect(rest.post).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps existing loop when start is called repeatedly", async () => {
    vi.useFakeTimers();
    try {
      const rest = createTypingRestClientStub();
      const activeTypingLoops = new Map<string, ReturnType<typeof setInterval>>();

      await startTypingLoop({
        activeTypingLoops,
        channelId: "channel-1",
        rest,
      });
      await expect(
        startTypingLoop({
          activeTypingLoops,
          channelId: "channel-1",
          rest,
        }),
      ).resolves.toEqual({
        alreadyRunning: true,
        ok: true,
      });

      expect(activeTypingLoops.size).toBe(1);
      expect(rest.post).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops loop by channel id", async () => {
    vi.useFakeTimers();
    try {
      const rest = createTypingRestClientStub();
      const activeTypingLoops = new Map<string, ReturnType<typeof setInterval>>();

      await startTypingLoop({
        activeTypingLoops,
        channelId: "channel-1",
        rest,
      });
      stopTypingLoop({
        activeTypingLoops,
        channelId: "channel-1",
      });

      await vi.advanceTimersByTimeAsync(24_000);
      expect(rest.post).toHaveBeenCalledTimes(1);
      expect(activeTypingLoops.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops all running loops", async () => {
    vi.useFakeTimers();
    try {
      const rest = createTypingRestClientStub();
      const activeTypingLoops = new Map<string, ReturnType<typeof setInterval>>();

      await startTypingLoop({
        activeTypingLoops,
        channelId: "channel-1",
        rest,
      });
      await startTypingLoop({
        activeTypingLoops,
        channelId: "channel-2",
        rest,
      });
      stopAllTypingLoops({
        activeTypingLoops,
      });

      await vi.advanceTimersByTimeAsync(16_000);
      expect(rest.post).toHaveBeenCalledTimes(2);
      expect(activeTypingLoops.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function createRestClientStub() {
  const put = vi.fn(async () => {});
  const post = vi.fn(async () => {});
  return {
    post,
    put,
  } satisfies Pick<REST, "post" | "put">;
}

function createTypingRestClientStub() {
  const post = vi.fn(async () => {});
  return {
    post,
  } satisfies Pick<REST, "post">;
}

function createAttachmentStoreStub(): DiscordAttachmentStore {
  return {
    saveAttachment: vi.fn(async () => "/tmp/attachment"),
  };
}
