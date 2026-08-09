import { describe, expect, it } from "vitest";

import {
  createDiscordConversationSession,
  createDiscordMessageEvent,
  DISCORD_EVENT_SOURCE,
  DISCORD_MESSAGE_CREATED_EVENT_TYPE,
} from "./discord-event";
import type { DiscordMessage } from "./discord-message";

const scope = { kind: "guild_channel", guildId: "300", channelId: "200" } as const;
const message: DiscordMessage = {
  id: "400",
  timestamp: "2026-07-23T00:00:00.000Z",
  kind: "default",
  guild: { id: "300", name: "Luna Lab" },
  channel: { id: "200", name: "general" },
  author: { id: "100", kind: "human", username: "shun", displayName: "Shun" },
  content: "hello",
  attachments: [],
  stickers: [],
  reactions: [],
  mentions: { users: [], roles: [], channels: [], everyone: false },
  replyTo: null,
};

describe("Discord event factory", () => {
  it("scopeからstableなConversationSessionを作る", () => {
    expect(createDiscordConversationSession(scope)).toEqual({
      key: "discord:guild_channel:300:200",
      source: DISCORD_EVENT_SOURCE,
      context: scope,
    });
  });

  it("Discord Messageの情報量を維持したLunaEventを作る", () => {
    expect(createDiscordMessageEvent(scope, message)).toEqual({
      id: "400",
      type: DISCORD_MESSAGE_CREATED_EVENT_TYPE,
      source: DISCORD_EVENT_SOURCE,
      subject: "discord:guild_channel:300:200",
      occurredAt: "2026-07-23T00:00:00.000Z",
      data: { scope, message },
    });
  });
});
