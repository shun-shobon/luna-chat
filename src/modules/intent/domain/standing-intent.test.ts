import { describe, expect, it } from "vitest";

import { findFiringIntents } from "./standing-intent";
import type { StandingIntent } from "./standing-intent";

const NOW = new Date("2026-11-14T12:00:00.000Z");

function intent(overrides: Partial<StandingIntent> = {}): StandingIntent {
	return {
		id: "ask-trip",
		keywords: ["旅行", "Trip"],
		action: "旅行の感想を聞く",
		expiresAt: new Date("2026-12-01T00:00:00.000Z"),
		cooldownHours: 24,
		maxFires: 3,
		...overrides,
	};
}

describe("findFiringIntents", () => {
	it("全角半角と大文字小文字を揃えて、最初に含まれていたキーワードで発火する", () => {
		expect(
			findFiringIntents({ intents: [intent()], states: {}, text: "ＴＲＩＰ楽しかった", now: NOW }),
		).toEqual([{ intent: intent(), keyword: "Trip" }]);
	});

	it.each([
		["キーワードがない", intent(), {}, "今日は晴れ"],
		["期限を過ぎた", intent({ expiresAt: NOW }), {}, "旅行"],
		[
			"発火回数の上限に達した",
			intent(),
			{ "ask-trip": { fires: 3, lastFiredAt: "2026-11-01T00:00:00.000Z" } },
			"旅行",
		],
		[
			"前回からcooldownが経っていない",
			intent(),
			{ "ask-trip": { fires: 1, lastFiredAt: "2026-11-14T00:00:00.000Z" } },
			"旅行",
		],
	])("%s予定は発火しない", (_label, standing, states, text) => {
		expect(findFiringIntents({ intents: [standing], states, text, now: NOW })).toEqual([]);
	});

	it("cooldownが経てば再び発火する", () => {
		expect(
			findFiringIntents({
				intents: [intent()],
				states: { "ask-trip": { fires: 1, lastFiredAt: "2026-11-13T12:00:00.000Z" } },
				text: "旅行",
				now: NOW,
			}),
		).toHaveLength(1);
	});
});
