import { describe, expect, it, vi } from "vitest";

import { TypingLeaseRegistry } from "../application/typing-lease-registry";
import type { SendFileResolverPort } from "../ports/send-file-resolver-port";

import { DiscordActionAdapter, type DiscordActionClient } from "./discord-action-adapter";

describe("DiscordActionAdapter", () => {
  it("DMを解決してmessageを送信する", async () => {
    const send = vi.fn(async () => ({ id: "300" }));
    const client = createClient({ ...createChannel(), send });
    const adapter = createAdapter(client);

    await expect(
      adapter.execute(
        { kind: "send_message", target: { kind: "dm_user", userId: "100" }, content: "hello" },
        "turn-1",
      ),
    ).resolves.toEqual({
      actionKind: "send_message",
      detail: { channelId: "200", messageId: "300" },
    });
    expect(client.users.createDM).toHaveBeenCalledWith("100");
    expect(client.channels.fetch).toHaveBeenCalledWith("200");
    expect(send).toHaveBeenCalledWith({ content: "hello" });
  });

  it("reply失敗を通常投稿へ変換しない", async () => {
    const reply = vi.fn(async () => await Promise.reject(new Error("unknown message")));
    const channel = createChannel({ reply });
    const adapter = createAdapter(createClient(channel));

    await expect(
      adapter.execute(
        { kind: "reply_message", channelId: "200", messageId: "300", content: "hello" },
        "turn-1",
      ),
    ).rejects.toThrow("unknown message");
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("ownerが開始したtypingだけを停止する", async () => {
    const channel = createChannel();
    const registry = new TypingLeaseRegistry(60_000, vi.fn());
    const adapter = createAdapter(createClient(channel), registry);

    await adapter.execute(
      { kind: "start_typing", target: { kind: "channel", channelId: "200" } },
      "turn-1",
    );
    await adapter.execute(
      { kind: "stop_typing", target: { kind: "channel", channelId: "200" } },
      "turn-2",
    );
    expect(registry.size).toBe(1);

    await adapter.releaseTyping("turn-1");
    expect(registry.size).toBe(0);
  });

  it("Luna自身のreactionを削除する", async () => {
    const remove = vi.fn(async () => undefined);
    const resolve = vi.fn(() => ({ users: { remove } }));
    const adapter = createAdapter(createClient(createChannel({ resolve })));

    await adapter.execute(
      {
        kind: "remove_reaction",
        channelId: "200",
        messageId: "300",
        emoji: { kind: "custom", id: "400", name: "luna" },
      },
      "turn-1",
    );

    expect(resolve).toHaveBeenCalledWith("luna:400");
    expect(remove).toHaveBeenCalledOnce();
  });
});

function createAdapter(
  client: DiscordActionClient,
  typing = new TypingLeaseRegistry(60_000, vi.fn()),
): DiscordActionAdapter {
  const files: SendFileResolverPort = {
    resolve: vi.fn(async (file) => ({ path: file.path })),
  };
  return new DiscordActionAdapter(client, files, typing);
}

function createClient(channel: ReturnType<typeof createChannel>): DiscordActionClient {
  return {
    channels: { fetch: vi.fn(async () => channel) },
    users: { createDM: vi.fn(async () => ({ id: "200" })) },
  };
}

function createChannel(
  overrides: {
    reply?: (options: unknown) => Promise<unknown>;
    resolve?: (emoji: string) => unknown;
  } = {},
) {
  const message = {
    reply: overrides.reply ?? vi.fn(async () => ({ id: "301" })),
    react: vi.fn(async () => undefined),
    reactions: { resolve: overrides.resolve ?? vi.fn(() => undefined) },
  };
  return {
    id: "200",
    send: vi.fn(async () => ({ id: "300" })),
    sendTyping: vi.fn(async () => undefined),
    messages: { fetch: vi.fn(async () => message) },
  };
}
