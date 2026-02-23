import { describe, expect, it } from "vitest";

import { evaluateReplyPolicy } from "./reply-policy";

const allowedChannelIds = new Set(["allowed"]);

describe("evaluateReplyPolicy", () => {
  it("DM は処理しない", () => {
    const decision = evaluateReplyPolicy({
      allowedChannelIds,
      channelId: "allowed",
      isDm: true,
      isThread: false,
      mentionedBot: true,
    });

    expect(decision).toEqual({ shouldHandle: false, forceReply: false });
  });

  it("指定外チャンネルは処理しない", () => {
    const decision = evaluateReplyPolicy({
      allowedChannelIds,
      channelId: "other",
      isDm: false,
      isThread: false,
      mentionedBot: true,
    });

    expect(decision).toEqual({ shouldHandle: false, forceReply: false });
  });

  it("メンションありは強制返信", () => {
    const decision = evaluateReplyPolicy({
      allowedChannelIds,
      channelId: "allowed",
      isDm: false,
      isThread: false,
      mentionedBot: true,
    });

    expect(decision).toEqual({ shouldHandle: true, forceReply: true });
  });

  it("メンションなしは AI 判定に委譲", () => {
    const decision = evaluateReplyPolicy({
      allowedChannelIds,
      channelId: "allowed",
      isDm: false,
      isThread: false,
      mentionedBot: false,
    });

    expect(decision).toEqual({ shouldHandle: true, forceReply: false });
  });
});
