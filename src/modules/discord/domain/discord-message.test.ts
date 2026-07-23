import { describe, expect, it } from "vitest";

import { discordMessageSchema } from "./discord-message";

const message = {
  id: "100",
  timestamp: "2026-07-23T10:00:00.000+09:00",
  kind: "reply",
  guild: { id: "200", name: "Luna Lab" },
  channel: { id: "300", name: "general" },
  author: { id: "400", kind: "human", username: "shun", displayName: "Shun" },
  content: "hello",
  attachments: [
    {
      id: "500",
      name: "image.png",
      url: "https://cdn.discordapp.com/attachments/image.png",
      contentType: "image/png",
      size: 42,
      width: 10,
      height: 20,
    },
  ],
  stickers: [],
  reactions: [
    { emoji: { kind: "custom", id: "600", name: "luna", animated: false }, count: 2, me: true },
  ],
  mentions: {
    users: [{ id: "700", username: "luna", displayName: null }],
    roles: [],
    channels: [],
    everyone: false,
  },
  replyTo: { kind: "guild", guildId: "200", channelId: "300", messageId: "99" },
};

describe("discordMessageSchema", () => {
  it("型付きmessage metadataを検証する", () => {
    expect(discordMessageSchema.parse(message)).toEqual(message);
  });

  it("DM返信にguildIdを許可しない", () => {
    expect(
      discordMessageSchema.safeParse({
        ...message,
        guild: null,
        replyTo: { kind: "dm", guildId: "200", channelId: "300", messageId: "99" },
      }).success,
    ).toBe(false);
  });
});
