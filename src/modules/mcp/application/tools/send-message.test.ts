import { describe, expect, it, vi } from "vitest";

import type { TypingLifecycleRegistry } from "../../../typing/typing-lifecycle-registry";
import type { DiscordCommandGateway } from "../../ports/outbound/discord-command-gateway-port";

import { sendMessageTool } from "./send-message";

describe("sendMessageTool", () => {
  it("送信成功時は同一 channel の typing を停止する", async () => {
    const resolveChannelId: DiscordCommandGateway["resolveChannelId"] = vi.fn(
      async () => "channel-1",
    );
    const sendMessage: DiscordCommandGateway["sendMessage"] = vi.fn(async () => ({
      ok: true as const,
    }));
    const gateway = createGatewayStub({
      resolveChannelId,
      sendMessage,
    });
    const typingRegistry = createTypingRegistryStub();

    await expect(
      sendMessageTool({
        filePaths: ["/tmp/file-1.txt", "/tmp/file-2.txt"],
        gateway,
        target: { channelId: "channel-1" },
        text: "hello",
        typingRegistry,
      }),
    ).resolves.toEqual({ ok: true });

    expect(resolveChannelId).toHaveBeenCalledWith({ channelId: "channel-1" });
    expect(sendMessage).toHaveBeenCalledWith({
      channelId: "channel-1",
      filePaths: ["/tmp/file-1.txt", "/tmp/file-2.txt"],
      text: "hello",
    });
    expect(typingRegistry.stopByChannelId).toHaveBeenCalledWith("channel-1");
  });

  it("DM 送信成功時は解決した DM channel の typing を停止する", async () => {
    const resolveChannelId: DiscordCommandGateway["resolveChannelId"] = vi.fn(
      async () => "dm-channel-1",
    );
    const sendMessage: DiscordCommandGateway["sendMessage"] = vi.fn(async () => ({
      ok: true as const,
    }));
    const gateway = createGatewayStub({
      resolveChannelId,
      sendMessage,
    });
    const typingRegistry = createTypingRegistryStub();

    await sendMessageTool({
      gateway,
      target: { userId: "user-1" },
      text: "hello",
      typingRegistry,
    });

    expect(resolveChannelId).toHaveBeenCalledWith({ userId: "user-1" });
    expect(typingRegistry.stopByChannelId).toHaveBeenCalledWith("dm-channel-1");
  });

  it("本文なしでも filePaths を渡せる", async () => {
    const sendMessage: DiscordCommandGateway["sendMessage"] = vi.fn(async () => ({
      ok: true as const,
    }));
    const gateway = createGatewayStub({
      sendMessage,
    });
    const typingRegistry = createTypingRegistryStub();

    await expect(
      sendMessageTool({
        filePaths: ["/tmp/file-1.txt", "/tmp/file-2.txt"],
        gateway,
        target: { channelId: "channel-1" },
        typingRegistry,
      }),
    ).resolves.toEqual({ ok: true });

    expect(sendMessage).toHaveBeenCalledWith({
      channelId: "channel-1",
      filePaths: ["/tmp/file-1.txt", "/tmp/file-2.txt"],
      text: undefined,
    });
  });

  it("複数ファイル添付を gateway へそのまま渡す", async () => {
    const sendMessage: DiscordCommandGateway["sendMessage"] = vi.fn(async () => ({
      ok: true as const,
    }));
    const gateway = createGatewayStub({
      sendMessage,
    });
    const typingRegistry = createTypingRegistryStub();

    await sendMessageTool({
      filePaths: ["/tmp/a.txt", "/tmp/b.txt"],
      gateway,
      target: { channelId: "channel-1" },
      typingRegistry,
    });

    expect(sendMessage).toHaveBeenCalledWith({
      channelId: "channel-1",
      filePaths: ["/tmp/a.txt", "/tmp/b.txt"],
      text: undefined,
    });
  });

  it("送信失敗時は typing を停止しない", async () => {
    const gateway = createGatewayStub({
      sendMessage: vi.fn(async () => {
        throw new Error("send failed");
      }),
    });
    const typingRegistry = createTypingRegistryStub();

    await expect(
      sendMessageTool({
        gateway,
        target: { channelId: "channel-1" },
        text: "hello",
        typingRegistry,
      }),
    ).rejects.toThrow("send failed");

    expect(typingRegistry.stopByChannelId).not.toHaveBeenCalled();
  });
});

function createGatewayStub(
  overrides: Partial<{
    [Key in keyof DiscordCommandGateway]: DiscordCommandGateway[Key];
  }> = {},
): DiscordCommandGateway {
  const resolveChannelId: DiscordCommandGateway["resolveChannelId"] = vi.fn(
    async () => "channel-1",
  );
  const addReaction: DiscordCommandGateway["addReaction"] = vi.fn(async () => ({
    ok: true as const,
  }));
  const sendMessage: DiscordCommandGateway["sendMessage"] = vi.fn(async () => ({
    ok: true as const,
  }));
  const sendTyping: DiscordCommandGateway["sendTyping"] = vi.fn(async () => undefined);

  return {
    addReaction: overrides.addReaction ?? addReaction,
    resolveChannelId: overrides.resolveChannelId ?? resolveChannelId,
    sendMessage: overrides.sendMessage ?? sendMessage,
    sendTyping: overrides.sendTyping ?? sendTyping,
  };
}

function createTypingRegistryStub(): TypingLifecycleRegistry {
  return {
    start: vi.fn(() => ({
      alreadyRunning: false,
      ok: true as const,
      stop: () => undefined,
    })),
    stopAll: vi.fn(() => undefined),
    stopByChannelId: vi.fn(() => undefined),
  };
}
