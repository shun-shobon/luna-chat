import { describe, expect, it } from "vitest";

import { reactionInputSchema, sendMessageInputSchema, typingInputSchema } from "./discord-action";

describe("Discord action input schemas", () => {
	it("対応済みactionの入力を検証する", () => {
		expect(
			sendMessageInputSchema.parse({ target: { kind: "dm_user", userId: "123" }, content: "hi" }),
		).toMatchObject({ content: "hi" });
		expect(
			reactionInputSchema.parse({
				channelId: "456",
				messageId: "789",
				emoji: { kind: "unicode", value: "🌙" },
			}),
		).toMatchObject({ messageId: "789" });
	});

	it("本文もfileもないmessageを拒否する", () => {
		expect(
			sendMessageInputSchema.safeParse({ target: { kind: "channel", channelId: "123" } }).success,
		).toBe(false);
	});

	it("未知fieldを拒否する", () => {
		expect(
			typingInputSchema.safeParse({
				target: { kind: "channel", channelId: "123" },
				fallback: true,
			}).success,
		).toBe(false);
	});

	it("Discordの本文上限を超えるmessageを拒否する", () => {
		expect(
			sendMessageInputSchema.safeParse({
				target: { kind: "channel", channelId: "123" },
				content: "a".repeat(2_001),
			}).success,
		).toBe(false);
	});
});
