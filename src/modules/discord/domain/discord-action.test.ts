import { describe, expect, it } from "vitest";

import { agentOutputSchema, discordActionSchema } from "./discord-action";

describe("discordActionSchema", () => {
  it("対応済みactionだけを検証する", () => {
    expect(
      agentOutputSchema.parse({
        actions: [
          { kind: "send_message", target: { kind: "dm_user", userId: "123" }, content: "hi" },
          {
            kind: "add_reaction",
            channelId: "456",
            messageId: "789",
            emoji: { kind: "unicode", value: "🌙" },
          },
        ],
      }).actions,
    ).toHaveLength(2);
  });

  it("本文もfileもないmessageを拒否する", () => {
    expect(
      discordActionSchema.safeParse({
        kind: "send_message",
        target: { kind: "channel", channelId: "123" },
      }).success,
    ).toBe(false);
  });

  it("未知actionと未知fieldを拒否する", () => {
    expect(discordActionSchema.safeParse({ kind: "delete_message" }).success).toBe(false);
    expect(
      discordActionSchema.safeParse({
        kind: "start_typing",
        target: { kind: "channel", channelId: "123" },
        fallback: true,
      }).success,
    ).toBe(false);
  });

  it("Discordの本文上限を超えるmessageを拒否する", () => {
    expect(
      discordActionSchema.safeParse({
        kind: "send_message",
        target: { kind: "channel", channelId: "123" },
        content: "a".repeat(2_001),
      }).success,
    ).toBe(false);
  });
});
