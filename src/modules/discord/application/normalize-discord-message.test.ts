import { describe, expect, it } from "vitest";

import type { DiscordMessageSource } from "./normalize-discord-message";
import { normalizeDiscordMessage } from "./normalize-discord-message";

describe("normalizeDiscordMessage", () => {
  it("webhookをbotより優先して分類し、replyを保持する", () => {
    expect(
      normalizeDiscordMessage(
        source({
          webhookId: "900",
          author: {
            id: "400",
            username: "hook",
            displayName: null,
            bot: true,
            system: false,
          },
          replyTo: { kind: "guild", guildId: "200", channelId: "300", messageId: "99" },
        }),
      ),
    ).toMatchObject({ kind: "reply", author: { kind: "webhook" }, replyTo: { messageId: "99" } });
  });

  it("不正なSDK由来metadataを境界で拒否する", () => {
    expect(() =>
      normalizeDiscordMessage(source({ attachments: [{ ...attachment, url: "invalid-url" }] })),
    ).toThrow();
  });
});

const attachment = {
  id: "500",
  name: "image.png",
  url: "https://cdn.discordapp.com/image.png",
  contentType: "image/png",
  size: 10,
  width: 20,
  height: 30,
} as const;

function source(overrides: Partial<DiscordMessageSource> = {}): DiscordMessageSource {
  return {
    id: "100",
    timestamp: new Date("2026-07-23T01:00:00.000Z"),
    system: false,
    guild: { id: "200", name: "Luna Lab" },
    channel: { id: "300", name: "general" },
    author: {
      id: "400",
      username: "shun",
      displayName: "Shun",
      bot: false,
      system: false,
    },
    webhookId: null,
    content: "hello",
    attachments: [attachment],
    stickers: [],
    reactions: [],
    mentions: { users: [], roles: [], channels: [], everyone: false },
    replyTo: null,
    ...overrides,
  };
}
