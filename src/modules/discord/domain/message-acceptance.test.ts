import { describe, expect, it } from "vitest";

import { shouldAcceptMessage } from "./message-acceptance";

const base = {
  authorId: "100",
  lunaUserId: "999",
  mentionsLuna: false,
  allowDm: true,
  allowedChannelIds: new Set<string>(),
  lunaIsThreadMember: false,
  sessionExists: false,
};

describe("shouldAcceptMessage", () => {
  it("Luna自身を拒否する", () => {
    expect(
      shouldAcceptMessage({
        ...base,
        authorId: "999",
        scope: { kind: "dm", channelId: "200", userId: "100" },
      }),
    ).toBe(false);
  });

  it.each([
    [true, true],
    [false, false],
  ])("DMの受付設定が%sなら受付結果は%sになる", (allowDm, accepted) => {
    expect(
      shouldAcceptMessage({
        ...base,
        allowDm,
        scope: { kind: "dm", channelId: "200", userId: "100" },
      }),
    ).toBe(accepted);
  });

  it("許可Guild channel配下のthreadを常設として受理する", () => {
    expect(
      shouldAcceptMessage({
        ...base,
        allowedChannelIds: new Set(["200"]),
        lunaIsThreadMember: true,
        scope: { kind: "guild_thread", guildId: "300", parentChannelId: "200", threadId: "201" },
      }),
    ).toBe(true);
  });

  it("IDを直接許可したLuna参加中のthreadを常設として受理する", () => {
    expect(
      shouldAcceptMessage({
        ...base,
        allowedChannelIds: new Set(["201"]),
        lunaIsThreadMember: true,
        scope: { kind: "guild_thread", guildId: "300", parentChannelId: "200", threadId: "201" },
      }),
    ).toBe(true);
  });

  it("許可Guild channel配下でもLuna未参加のthreadを常設として受理しない", () => {
    expect(
      shouldAcceptMessage({
        ...base,
        allowedChannelIds: new Set(["200"]),
        scope: { kind: "guild_thread", guildId: "300", parentChannelId: "200", threadId: "201" },
      }),
    ).toBe(false);
  });

  it("Luna未参加のthreadでも同じscopeの一時sessionではmentionなし投稿を受理する", () => {
    expect(
      shouldAcceptMessage({
        ...base,
        sessionExists: true,
        scope: { kind: "guild_thread", guildId: "300", parentChannelId: "200", threadId: "201" },
      }),
    ).toBe(true);
  });

  it("Luna未参加のthreadでもmention付き投稿を受理する", () => {
    expect(
      shouldAcceptMessage({
        ...base,
        mentionsLuna: true,
        scope: { kind: "guild_thread", guildId: "300", parentChannelId: "200", threadId: "201" },
      }),
    ).toBe(true);
  });
});
