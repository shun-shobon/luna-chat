import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { AcceptedConversationEvent } from "../../conversation/domain/conversation-session";
import { createDiscordDelegatedEvent } from "../domain/discord-event";

import type { DiscordActionClient } from "./discord-action-adapter";
import { DiscordConversationDelegation } from "./discord-conversation-delegation";

const occurredAt = new Date("2026-07-23T00:00:00.000Z");

describe("DiscordConversationDelegation", () => {
  it("Guild channelを解決し、そのsessionへ委譲Eventを渡す", async () => {
    const accept = vi.fn((_input: AcceptedConversationEvent) => true);
    const delegation = createDelegation(
      client({ id: "200", type: ChannelType.GuildText, guildId: "300", send: vi.fn() }),
      { accept },
    );

    const scope = await delegation.delegate({ kind: "channel", channelId: "200" }, "brief");

    const expectedScope = { kind: "guild_channel", guildId: "300", channelId: "200" } as const;
    expect(scope).toEqual(expectedScope);
    expect(accept).toHaveBeenCalledWith({
      session: {
        key: "discord:guild_channel:300:200",
        source: "discord/main",
        context: expectedScope,
      },
      event: createDiscordDelegatedEvent({
        id: "delegation-1",
        scope: expectedScope,
        brief: "brief",
        occurredAt,
      }),
    });
  });

  it("threadは親channelを含むthread scopeへ解決する", async () => {
    const delegation = createDelegation(
      client({
        id: "210",
        type: ChannelType.PublicThread,
        guildId: "300",
        parentId: "200",
        send: vi.fn(),
      }),
    );

    await expect(
      delegation.delegate({ kind: "channel", channelId: "210" }, "brief"),
    ).resolves.toEqual({
      kind: "guild_thread",
      guildId: "300",
      parentChannelId: "200",
      threadId: "210",
    });
  });

  it("DM userはDM channelを開いてDM scopeへ解決する", async () => {
    const createDM = vi.fn(async () => ({ id: "500" }));
    const delegation = createDelegation({
      channels: { fetch: vi.fn() },
      users: { createDM },
    });

    await expect(delegation.delegate({ kind: "dm_user", userId: "100" }, "brief")).resolves.toEqual(
      { kind: "dm", channelId: "500", userId: "100" },
    );
    expect(createDM).toHaveBeenCalledWith("100");
  });

  it("allow_dm無効時のDM委譲を受理前に拒否する", async () => {
    const accept = vi.fn(() => true);
    const delegation = createDelegation(
      { channels: { fetch: vi.fn() }, users: { createDM: vi.fn(async () => ({ id: "500" })) } },
      { accept, allowDm: false },
    );

    await expect(delegation.delegate({ kind: "dm_user", userId: "100" }, "brief")).rejects.toThrow(
      "allow_dm",
    );
    expect(accept).not.toHaveBeenCalled();
  });

  it("送信できないchannelを拒否する", async () => {
    const delegation = createDelegation(
      client({ id: "200", type: ChannelType.GuildCategory, guildId: "300" }),
    );

    await expect(
      delegation.delegate({ kind: "channel", channelId: "200" }, "brief"),
    ).rejects.toThrow("cannot hold a conversation");
  });

  it("会話intake停止中の委譲を失敗にする", async () => {
    const delegation = createDelegation(
      client({ id: "200", type: ChannelType.GuildText, guildId: "300", send: vi.fn() }),
      { accept: () => false },
    );

    await expect(
      delegation.delegate({ kind: "channel", channelId: "200" }, "brief"),
    ).rejects.toThrow("intake is stopped");
  });

  it("channel取得の例外をそのまま返す", async () => {
    const delegation = createDelegation({
      channels: { fetch: vi.fn(async () => await Promise.reject(new Error("Unknown Channel"))) },
      users: { createDM: vi.fn() },
    });

    await expect(
      delegation.delegate({ kind: "channel", channelId: "200" }, "brief"),
    ).rejects.toThrow("Unknown Channel");
  });
});

function client(channel: Record<string, unknown>): DiscordActionClient {
  return { channels: { fetch: vi.fn(async () => channel) }, users: { createDM: vi.fn() } };
}

function createDelegation(
  discord: DiscordActionClient,
  overrides: Partial<{
    accept(input: AcceptedConversationEvent): boolean;
    allowDm: boolean;
  }> = {},
): DiscordConversationDelegation {
  return new DiscordConversationDelegation(discord, {
    accept: overrides.accept ?? (() => true),
    allowDm: overrides.allowDm ?? true,
    createId: () => "delegation-1",
    now: () => occurredAt,
  });
}
