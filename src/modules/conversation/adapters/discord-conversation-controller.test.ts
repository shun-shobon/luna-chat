import { describe, expect, it, vi } from "vitest";

import type { DiscordGatewayMessage } from "../../discord/ports/discord-gateway-port";

import { DiscordConversationController } from "./discord-conversation-controller";

describe("DiscordConversationController", () => {
  it("常設channelとmention開始sessionをconversationへ渡す", () => {
    const conversation = createConversation(false);
    const controller = createController(conversation);

    controller.onMessage(event("200", false));
    controller.onMessage(event("201", true));
    controller.onMessage(event("202", false));

    expect(conversation.accept).toHaveBeenCalledTimes(2);
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

  it("許可channel配下のthreadはLuna参加中だけmentionなしでconversationへ渡す", () => {
    const conversation = createConversation(false);
    const controller = createController(conversation);

    controller.onMessage(threadEvent(true));
    controller.onMessage(threadEvent(false));

    expect(conversation.accept).toHaveBeenCalledOnce();
    expect(conversation.accept).toHaveBeenCalledWith(threadEvent(true));
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
