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
    });

    expect(decision).toEqual({ shouldHandle: false });
  });

  it("指定外チャンネルは処理しない", () => {
    const decision = evaluateReplyPolicy({
      allowedChannelIds,
      channelId: "other",
      isDm: false,
      isThread: false,
    });

    expect(decision).toEqual({ shouldHandle: false });
  });

  it("指定チャンネルは処理する", () => {
    const decision = evaluateReplyPolicy({
      allowedChannelIds,
      channelId: "allowed",
      isDm: false,
      isThread: false,
    });

    expect(decision).toEqual({ shouldHandle: true });
  });
});
