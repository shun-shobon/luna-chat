import { describe, expect, it, vi } from "vitest";

import type { DiscordGatewayMessage, DiscordGatewayTyping } from "../ports/discord-gateway-port";

import { DiscordGatewayAdapter, type DiscordGatewayEventClient } from "./discord-gateway-adapter";

describe("DiscordGatewayAdapter", () => {
  it("messageCreateとtypingStartだけを購読し、正規化済みeventをportへ渡す", async () => {
    const client = new FakeGatewayClient();
    const onMessage = vi.fn(async (_event: DiscordGatewayMessage) => undefined);
    const onTyping = vi.fn(async (_event: DiscordGatewayTyping) => undefined);
    const onError = vi.fn();
    const adapter = new DiscordGatewayAdapter(client, { onMessage, onTyping, onError });

    adapter.start();
    client.emit("messageCreate", createMessage());
    client.emit("typingStart", {
      channel: createChannel(),
      guild: { id: "200" },
      user: createUser({ id: "401" }),
    });
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(onTyping).toHaveBeenCalledOnce());

    expect(onMessage.mock.calls[0]?.[0].scope).toEqual({
      kind: "guild_channel",
      guildId: "200",
      channelId: "300",
    });
    expect(onTyping.mock.calls[0]?.[0]).toEqual({
      scope: { kind: "guild_channel", guildId: "200", channelId: "300" },
      userId: "401",
      isHuman: true,
    });
    adapter.stop();
    expect(client.listenerCount()).toBe(0);
  });

  it("変換失敗とport失敗を明示的にonErrorへ渡す", async () => {
    const client = new FakeGatewayClient();
    const onError = vi.fn();
    const adapter = new DiscordGatewayAdapter(client, {
      onMessage: vi.fn(async () => await Promise.reject(new Error("port failed"))),
      onTyping: vi.fn(),
      onError,
    });
    adapter.start();

    client.emit("messageCreate", createMessage());
    client.emit("typingStart", {});
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(onError.mock.calls.map((call) => call[1])).toEqual(["typingStart", "messageCreate"]);
  });

  it("二重startと未start stopを拒否する", () => {
    const client = new FakeGatewayClient();
    const port = { onMessage: vi.fn(), onTyping: vi.fn(), onError: vi.fn() };
    const adapter = new DiscordGatewayAdapter(client, port);

    expect(() => adapter.stop()).toThrow("not started");
    adapter.start();
    expect(() => adapter.start()).toThrow("already started");
  });
});

class FakeGatewayClient implements DiscordGatewayEventClient {
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  on(event: "messageCreate" | "typingStart", listener: (payload: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: "messageCreate" | "typingStart", listener: (payload: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: "messageCreate" | "typingStart", payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  listenerCount(): number {
    return Array.from(this.listeners.values()).reduce(
      (count, listeners) => count + listeners.size,
      0,
    );
  }
}

function createMessage() {
  return {
    id: "100",
    createdAt: new Date("2026-07-23T01:00:00.000Z"),
    system: false,
    guild: { id: "200", name: "Luna Lab" },
    channel: createChannel(),
    author: createUser(),
    member: { displayName: "Shun" },
    webhookId: null,
    content: "hello",
    attachments: new Map(),
    stickers: new Map(),
    reactions: { cache: new Map() },
    mentions: {
      users: new Map(),
      roles: new Map(),
      channels: new Map(),
      everyone: false,
    },
    reference: null,
  };
}

function createChannel() {
  return {
    id: "300",
    name: "general",
    parentId: null,
    recipient: null,
    isThread: () => false,
    isDMBased: () => false,
  };
}

function createUser(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "400",
    username: "shun",
    globalName: "Shun",
    bot: false,
    system: false,
    ...overrides,
  };
}
