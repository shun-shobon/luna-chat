import { describe, expect, it } from "vitest";

import {
  createDiscordConversationSession,
  createDiscordDelegatedEvent,
  createDiscordMessageEvent,
  DISCORD_CONVERSATION_DELEGATED_EVENT_TYPE,
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

  it("委譲Eventは対象sessionをsubjectにし、scopeとbriefを持つ", () => {
    expect(
      createDiscordDelegatedEvent({
        id: "delegation-1",
        scope,
        brief: "朝の予定を確認したい",
        occurredAt: new Date("2026-07-23T00:00:00.000Z"),
      }),
    ).toEqual({
      id: "delegation-1",
      type: DISCORD_CONVERSATION_DELEGATED_EVENT_TYPE,
      source: DISCORD_EVENT_SOURCE,
      subject: "discord:guild_channel:300:200",
      occurredAt: "2026-07-23T00:00:00.000Z",
      data: { scope, brief: "朝の予定を確認したい" },
    });
  });

  it("空のbriefを拒否する", () => {
    expect(() =>
      createDiscordDelegatedEvent({ id: "delegation-1", scope, brief: "", occurredAt: new Date() }),
    ).toThrow();
  });
});
