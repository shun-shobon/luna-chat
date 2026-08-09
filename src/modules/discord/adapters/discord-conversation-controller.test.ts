import { describe, expect, it, vi } from "vitest";

import { DISCORD_EVENT_SOURCE, DISCORD_MESSAGE_CREATED_EVENT_TYPE } from "../domain/discord-event";
import type { DiscordGatewayMessage } from "../ports/discord-gateway-port";

import { DiscordConversationController } from "./discord-conversation-controller";

describe("DiscordConversationController", () => {
  it("常設channelとmention開始sessionをConversationEventへ変換する", () => {
    const conversation = createConversation(false);
    const controller = createController(conversation);

    controller.onMessage(event("200", false));
    controller.onMessage(event("201", true));
    controller.onMessage(event("202", false));

    expect(conversation.accept).toHaveBeenCalledTimes(2);
    expect(conversation.accept).toHaveBeenNthCalledWith(1, {
      session: {
        key: "discord:guild_channel:300:200",
        source: DISCORD_EVENT_SOURCE,
        context: { kind: "guild_channel", guildId: "300", channelId: "200" },
      },
      event: expect.objectContaining({
        id: "400",
        type: DISCORD_MESSAGE_CREATED_EVENT_TYPE,
        source: DISCORD_EVENT_SOURCE,
        subject: "discord:guild_channel:300:200",
      }),
    });
    expect(conversation.hasSession).toHaveBeenCalledWith("discord:guild_channel:300:201");
  });

  it("Luna自身のmessageとbot typingを除外する", () => {
    const conversation = createConversation(true);
    const controller = createController(conversation);
    const own = event("200", false, "999");

    controller.onMessage(own);
    controller.onTyping({ scope: own.scope, userId: "100", isHuman: false });

    expect(conversation.accept).not.toHaveBeenCalled();
    expect(conversation.typing).not.toHaveBeenCalled();
  });

  it("human typingをConversationSessionへ変換する", () => {
    const conversation = createConversation(false);
    const controller = createController(conversation);

    controller.onTyping({
      scope: { kind: "dm", channelId: "800", userId: "100" },
      userId: "100",
      isHuman: true,
    });

    expect(conversation.typing).toHaveBeenCalledWith(
      {
        key: "discord:dm:800:100",
        source: DISCORD_EVENT_SOURCE,
        context: { kind: "dm", channelId: "800", userId: "100" },
      },
      "100",
    );
  });

  it("許可channel配下のthreadはLuna参加中だけmentionなしで受理する", () => {
    const conversation = createConversation(false);
    const controller = createController(conversation);

    controller.onMessage(threadEvent(true));
    controller.onMessage(threadEvent(false));

    expect(conversation.accept).toHaveBeenCalledOnce();
  });
});

function createController(conversation: ReturnType<typeof createConversation>) {
  return new DiscordConversationController(conversation, "999", {
    allowDm: true,
    allowedChannelIds: ["200"],
    onAccepted: vi.fn(),
    onError: vi.fn(),
  });
}

function createConversation(sessionExists: boolean) {
  return {
    accept: vi.fn(),
    typing: vi.fn(),
    hasSession: vi.fn(() => sessionExists),
  };
}

function event(channelId: string, mention: boolean, authorId = "100"): DiscordGatewayMessage {
  return {
    lunaIsThreadMember: false,
    scope: { kind: "guild_channel", guildId: "300", channelId },
    message: {
      id: "400",
      timestamp: "2026-07-23T00:00:00.000Z",
      kind: "default",
      guild: { id: "300", name: "Luna Lab" },
      channel: { id: channelId, name: "general" },
      author: { id: authorId, kind: "human", username: "shun", displayName: "Shun" },
      content: "hello",
      attachments: [],
      stickers: [],
      reactions: [],
      mentions: {
        users: mention ? [{ id: "999", username: "luna", displayName: "Luna" }] : [],
        roles: [],
        channels: [],
        everyone: false,
      },
      replyTo: null,
    },
  };
}

function threadEvent(lunaIsThreadMember: boolean): DiscordGatewayMessage {
  const base = event("201", false);
  return {
    ...base,
    lunaIsThreadMember,
    scope: { kind: "guild_thread", guildId: "300", parentChannelId: "200", threadId: "201" },
  };
}
