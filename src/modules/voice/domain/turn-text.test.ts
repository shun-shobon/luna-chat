import { describe, expect, it } from "vitest";

import { looksUnfinished } from "./turn-text";

describe("looksUnfinished", () => {
	it.each([
		"それでね、駅に着いたんだけど",
		"  駅に着いたんだけど  ",
		"雨が降ってたから",
		"遅れたので",
		"言ったのに",
		"食べたり",
		"歩きながら",
		"着いたら",
		"行くなら",
		"本とか",
		"眠かったし",
		"行きましたし",
		"そうですが",
		"それを",
		"今日は、",
		"today,",
		"えっと",
		"あの",
		"まあ",
		"なんか",
	])("「%s」は続きを言う途中と見る", (text) => {
		expect(looksUnfinished(text)).toBe(true);
	});

	it.each([
		"",
		"   ",
		"ありがとう",
		"なんで",
		"ちょっと待って",
		"それ見て",
		"教えてって",
		"それで",
		"行きます",
		"それで駅まで行って。",
		"行ったけど！",
		"行くから？",
		"えっと…",
		"「それで」",
		"(それで)",
		"それで♪",
		"done.",
	])("「%s」は言い終えたと見る", (text) => {
		expect(looksUnfinished(text)).toBe(false);
	});
});
