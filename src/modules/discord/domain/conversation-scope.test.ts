import { describe, expect, it } from "vitest";

import { conversationScopeKey, conversationScopeSchema } from "./conversation-scope";

describe("conversationScope", () => {
  it("scope種別を含む安定keyを作る", () => {
    expect(
      conversationScopeKey({
        kind: "guild_thread",
        guildId: "100",
        parentChannelId: "200",
        threadId: "300",
      }),
    ).toBe("guild_thread:100:200:300");
  });

  it("未知fieldを拒否する", () => {
    expect(
      conversationScopeSchema.safeParse({
        kind: "dm",
        channelId: "100",
        userId: "200",
        guildId: "300",
      }).success,
    ).toBe(false);
  });
});
