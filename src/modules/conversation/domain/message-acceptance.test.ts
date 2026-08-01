import { describe, expect, it } from "vitest";

import { shouldAcceptMessage } from "./message-acceptance";

const base = {
  authorId: "100",
  lunaUserId: "999",
  mentionsLuna: false,
  allowDm: true,
  allowedChannelIds: new Set<string>(),
  sessionExists: false,
};

describe("shouldAcceptMessage", () => {
  it("Luna自身だけを除外する", () => {
    expect(
      shouldAcceptMessage({
        ...base,
        authorId: "999",
        scope: { kind: "dm", channelId: "200", userId: "100" },
      }),
    ).toBe(false);
  });

  it("許可Guild channel配下のthreadを常設として受理する", () => {
    expect(
      shouldAcceptMessage({
        ...base,
        allowedChannelIds: new Set(["200"]),
        scope: { kind: "guild_thread", guildId: "300", parentChannelId: "200", threadId: "201" },
      }),
    ).toBe(true);
  });

  it("親channelの一時sessionを子threadへ継承しない", () => {
    expect(
      shouldAcceptMessage({
        ...base,
        scope: { kind: "guild_thread", guildId: "300", parentChannelId: "200", threadId: "201" },
      }),
    ).toBe(false);
  });

  it("同じscopeの一時sessionではmentionなし投稿を受理する", () => {
    expect(
      shouldAcceptMessage({
        ...base,
        sessionExists: true,
        scope: { kind: "guild_channel", guildId: "300", channelId: "200" },
      }),
    ).toBe(true);
  });
});
