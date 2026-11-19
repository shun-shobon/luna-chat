import { describe, expect, it } from "vitest";

import type { VoiceRecordEntry } from "./voice-record";
import { formatRecordLine, toRecordJson, VoiceRecord } from "./voice-record";

const report = (index: number): VoiceRecordEntry => ({
	kind: "report",
	at: new Date(0),
	text: `報告${index}`,
});
const texts = (entries: readonly VoiceRecordEntry[]): string[] =>
	entries.map((entry) => (entry.kind === "report" ? entry.text : entry.kind));

describe("VoiceRecord", () => {
	it("足した順に持ち、recent は新しい方から指定件数を古い順で返す", () => {
		const record = new VoiceRecord();
		for (let i = 0; i < 5; i++) record.add(report(i));

		expect(texts(record.recent(2))).toEqual(["報告3", "報告4"]);
		expect(texts(record.recent(10))).toHaveLength(5);
	});

	it("endSeq は足した件数を指し、since はその位置以降を返す", () => {
		const record = new VoiceRecord();
		expect(record.endSeq).toBe(0);
		record.add(report(0));
		record.add(report(1));
		const seq = record.endSeq;
		record.add(report(2));

		expect(seq).toBe(2);
		expect(record.endSeq).toBe(3);
		expect(texts(record.since(seq))).toEqual(["報告2"]);
		expect(record.since(record.endSeq)).toEqual([]);
	});

	it("300件を超えたら古いものから捨て、通し番号は捨てた分も数え続ける", () => {
		const record = new VoiceRecord();
		for (let i = 0; i < 305; i++) record.add(report(i));

		expect(record.endSeq).toBe(305);
		expect(texts(record.recent(1000))).toHaveLength(300);
		expect(texts(record.recent(1))).toEqual(["報告304"]);
		expect(texts(record.since(303))).toEqual(["報告303", "報告304"]);
	});

	it("捨てた位置を since に渡すと、残っている分をすべて返す", () => {
		const record = new VoiceRecord();
		for (let i = 0; i < 305; i++) record.add(report(i));

		const rest = record.since(2);
		expect(rest).toHaveLength(300);
		expect(texts(rest)[0]).toBe("報告5");
	});
});

describe("formatRecordLine", () => {
	const at = new Date(2026, 10, 19, 9, 5, 3);

	it.each([
		[null, "[09:05:03] たろう: こんにちは"],
		["backchannel", "[09:05:03] たろう (while Luna was speaking, a backchannel): こんにちは"],
		["not_to_luna", "[09:05:03] たろう (while Luna was speaking, not to Luna): こんにちは"],
	] as const)("聞いた発話は話者と、読み上げ中の声なら扱い（%s）を添える", (aside, line) => {
		expect(
			formatRecordLine({
				kind: "heard",
				at,
				userId: "1",
				speaker: "たろう",
				text: "こんにちは",
				aside,
			}),
		).toBe(line);
	});

	it("言った返事は再生し終えた文をつなげ、止めた文と言えなかった文を書き分ける", () => {
		expect(
			formatRecordLine({
				kind: "said",
				at,
				played: ["はい。", "そうです。"],
				cut: "それで",
				dropped: ["次に。", "最後に。"],
			}),
		).toBe(
			"[09:05:03] Luna: はい。そうです。 [cut off while saying: それで] [did not get to say: 次に。最後に。]",
		);
	});

	it("1文も再生し終えていない返事は、空の部分を詰めて書く", () => {
		expect(formatRecordLine({ kind: "said", at, played: [], cut: null, dropped: ["はい。"] })).toBe(
			"[09:05:03] Luna: [did not get to say: はい。]",
		);
	});

	it("裏への依頼と裏の報告をそれぞれの言い方で書く", () => {
		expect(formatRecordLine({ kind: "delegated", at, request: "天気を調べて" })).toBe(
			"[09:05:03] Luna asked her backstage self: 天気を調べて",
		);
		expect(formatRecordLine({ kind: "report", at, text: "晴れです" })).toBe(
			"[09:05:03] Backstage report: 晴れです",
		);
	});
});

describe("toRecordJson", () => {
	const at = new Date("2026-11-19T00:05:03.000Z");

	it("聞いた発話は aside が null なら aside を含めない", () => {
		expect(
			toRecordJson({
				kind: "heard",
				at,
				userId: "1",
				speaker: "たろう",
				text: "やあ",
				aside: null,
			}),
		).toEqual({
			at: "2026-11-19T00:05:03.000Z",
			type: "heard",
			user_id: "1",
			speaker: "たろう",
			text: "やあ",
		});
	});

	it("読み上げ中に聞いた発話は aside を含める", () => {
		expect(
			toRecordJson({
				kind: "heard",
				at,
				userId: "1",
				speaker: "たろう",
				text: "うん",
				aside: "backchannel",
			}),
		).toMatchObject({ type: "heard", aside: "backchannel" });
	});

	it("言った返事は再生できた範囲をそのまま写す", () => {
		const played = ["はい。"];
		const json = toRecordJson({ kind: "said", at, played, cut: null, dropped: [] });

		expect(json).toEqual({
			at: "2026-11-19T00:05:03.000Z",
			type: "said",
			played: ["はい。"],
			cut: null,
			dropped: [],
		});
		expect(json["played"]).not.toBe(played);
	});

	it("裏への依頼と裏の報告を種類ごとの形にする", () => {
		expect(toRecordJson({ kind: "delegated", at, request: "調べて" })).toEqual({
			at: "2026-11-19T00:05:03.000Z",
			type: "delegated",
			request: "調べて",
		});
		expect(toRecordJson({ kind: "report", at, text: "晴れ" })).toEqual({
			at: "2026-11-19T00:05:03.000Z",
			type: "report",
			text: "晴れ",
		});
	});
});
