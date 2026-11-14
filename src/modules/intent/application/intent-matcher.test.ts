import { describe, expect, it, vi } from "vitest";

import type { LunaEvent } from "../../event/domain/luna-event";
import { createRecordingLogger } from "../../observability/testing/recording-logger";
import type { IntentFireStates, StandingIntent } from "../domain/standing-intent";
import type { IntentStorePort } from "../ports/intent-store-port";
import { IntentMatcher } from "./intent-matcher";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const INTENT: StandingIntent = {
	id: "ask-trip",
	keywords: ["旅行"],
	action: "旅行の感想を聞く",
	expiresAt: new Date("2026-12-01T00:00:00.000Z"),
	cooldownHours: 24,
	maxFires: 2,
};

function message(id: string, content: string, kind = "human"): LunaEvent {
	return {
		id,
		type: "discord.message.created.v1",
		source: "discord/main",
		occurredAt: NOW.toISOString(),
		data: { message: { id, content, author: { id: "1", kind } } },
	};
}

function store(intents: readonly StandingIntent[], states: IntentFireStates = {}) {
	return {
		readIntents: vi.fn(() => intents),
		readStates: vi.fn(() => states),
		writeStates: vi.fn<IntentStorePort["writeStates"]>(),
	};
}

describe("IntentMatcher", () => {
	it("人の発言で発火した予定を intent 入力にし、発火を記録する", () => {
		const intents = store([INTENT]);
		const matcher = new IntentMatcher(intents, createRecordingLogger(), () => NOW);

		expect(matcher.match([message("10", "旅行から帰った"), message("11", "旅行", "bot")])).toEqual([
			{
				kind: "intent",
				text: JSON.stringify({
					id: "ask-trip",
					action: "旅行の感想を聞く",
					keyword: "旅行",
					messageId: "10",
					firesRemaining: 1,
				}),
			},
		]);
		expect(intents.writeStates).toHaveBeenCalledWith({
			"ask-trip": { fires: 1, lastFiredAt: NOW.toISOString() },
		});
	});

	it("同じ束の中で2回目は cooldown で発火しない", () => {
		const intents = store([INTENT]);
		const matcher = new IntentMatcher(intents, createRecordingLogger(), () => NOW);

		expect(matcher.match([message("10", "旅行"), message("12", "旅行また行きたい")])).toHaveLength(
			1,
		);
	});

	it("発火がなければ状態を書かず、人の発言がなければ予定も読まない", () => {
		const intents = store([INTENT]);
		const matcher = new IntentMatcher(intents, createRecordingLogger(), () => NOW);

		expect(matcher.match([message("10", "晴れ")])).toEqual([]);
		expect(matcher.match([message("11", "旅行", "bot")])).toEqual([]);
		expect(intents.writeStates).not.toHaveBeenCalled();
		expect(intents.readIntents).toHaveBeenCalledOnce();
	});

	it("予定が読めなければ記録して発火しない", () => {
		const logger = createRecordingLogger();
		const matcher = new IntentMatcher(
			{
				readIntents: () => {
					throw new Error("invalid TOML");
				},
				readStates: () => ({}),
				writeStates: vi.fn(),
			},
			logger,
			() => NOW,
		);

		expect(matcher.match([message("10", "旅行")])).toEqual([]);
		expect(logger.entries).toEqual([
			{
				level: "error",
				event: "intent.read_failed",
				context: {},
				details: { error: "invalid TOML" },
			},
		]);
	});
});
