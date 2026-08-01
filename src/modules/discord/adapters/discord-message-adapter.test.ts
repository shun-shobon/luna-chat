import { describe, expect, it } from "vitest";

import {
  toDiscordGatewayMessage,
  toDiscordGatewayTyping,
  toDiscordMessageSource,
} from "./discord-message-adapter";

describe("discord message adapter", () => {
  it("discord.js Message形状から検証済みmessageとGuild channel scopeを作る", () => {
    const event = toDiscordGatewayMessage(
      createMessage({ reference: { messageId: "99", channelId: "300", guildId: undefined } }),
    );

    expect(event.scope).toEqual({ kind: "guild_channel", guildId: "200", channelId: "300" });
    expect(event.message).toMatchObject({
      id: "100",
      kind: "reply",
      author: { id: "400", kind: "human", displayName: "Shun" },
      attachments: [{ id: "500", size: 42 }],
      replyTo: { kind: "guild", guildId: "200", channelId: "300", messageId: "99" },
    });
  });

  it("threadとDMを必要ID付きscopeへ解決する", () => {
    const thread = createMessage({
      channel: createChannel({ id: "301", name: "topic", parentId: "300", thread: true }),
    });
    expect(toDiscordGatewayMessage(thread).scope).toEqual({
      kind: "guild_thread",
      guildId: "200",
      parentChannelId: "300",
      threadId: "301",
    });

    const dm = createMessage({
      guild: null,
      channel: createChannel({ dm: true, id: "800", name: null, recipientId: "400" }),
      reference: { messageId: "99", channelId: "800", guildId: null },
    });
    expect(toDiscordGatewayMessage(dm).scope).toEqual({
      kind: "dm",
      channelId: "800",
      userId: "400",
    });
    expect(toDiscordGatewayMessage(dm).message.replyTo).toEqual({
      kind: "dm",
      channelId: "800",
      messageId: "99",
    });
  });

  it("webhookをbotより優先して分類し、SDK metadata不正を拒否する", () => {
    const webhook = createMessage({ webhookId: "700" });
    expect(toDiscordGatewayMessage(webhook).message.author.kind).toBe("webhook");

    const invalid = createMessage({
      attachments: collection([{ ...ATTACHMENT, url: "not-a-url" }]),
    });
    expect(() => toDiscordMessageSource(invalid)).not.toThrow();
    expect(() => toDiscordGatewayMessage(invalid)).toThrow();
  });

  it("typing eventをpolicy判断せずscopeとuserへ変換する", () => {
    expect(
      toDiscordGatewayTyping({
        channel: createChannel(),
        guild: { id: "200" },
        user: createUser({ id: "401" }),
      }),
    ).toEqual({
      scope: { kind: "guild_channel", guildId: "200", channelId: "300" },
      userId: "401",
      isHuman: true,
    });

    expect(
      toDiscordGatewayTyping({
        channel: createChannel(),
        guild: { id: "200" },
        user: createUser({ id: "402", bot: true }),
      }).isHuman,
    ).toBe(false);
  });
});

const ATTACHMENT = {
  id: "500",
  name: "image.png",
  url: "https://cdn.discordapp.com/image.png",
  contentType: "image/png",
  size: 42,
  width: 10,
  height: 20,
};

function createMessage(overrides: Readonly<Record<string, unknown>> = {}) {
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
    attachments: collection([ATTACHMENT]),
    stickers: collection([{ id: "600", name: "wave", description: null, format: 1 }]),
    reactions: {
      cache: collection([
        {
          count: 2,
          me: true,
          emoji: { id: null, name: "🌙", animated: null },
        },
      ]),
    },
    mentions: {
      users: collection([createUser({ id: "401", username: "luna" })]),
      roles: collection([{ id: "900", name: "member" }]),
      channels: collection([{ id: "901", name: "random" }]),
      everyone: false,
    },
    reference: { messageId: "99", channelId: "300", guildId: "200" },
    ...overrides,
  };
}

function createChannel(
  input: {
    id?: string;
    name?: string | null;
    parentId?: string | null;
    thread?: boolean;
    dm?: boolean;
    recipientId?: string;
  } = {},
) {
  return {
    id: input.id ?? "300",
    name: input.name === undefined ? "general" : input.name,
    parentId: input.parentId ?? null,
    recipient: input.dm ? createUser({ id: input.recipientId ?? "400" }) : null,
    isThread: () => input.thread === true,
    isDMBased: () => input.dm === true,
  };
}

function createUser(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "400",
    username: "shun",
    globalName: "Shun Global",
    bot: false,
    system: false,
    ...overrides,
  };
}

function collection(values: readonly unknown[]) {
  return new Map(values.map((value, index) => [String(index), value]));
}
