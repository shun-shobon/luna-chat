import { describe, expect, it } from "vitest";

import { SentenceSplitter } from "./sentence-splitter";

describe("SentenceSplitter", () => {
	it("文末の記号の後に次の文字が来たら、記号までを一文として返す", () => {
		const splitter = new SentenceSplitter();

		expect(splitter.push("こんに")).toEqual([]);
		expect(splitter.push("ちは")).toEqual([]);
		expect(splitter.push("。今日")).toEqual(["こんにちは。"]);
		expect(splitter.push("は晴れ！")).toEqual([]);
		expect(splitter.push("？そう")).toEqual(["今日は晴れ！？"]);
		expect(splitter.flush()).toBe("そう");
	});

	it("1回で届いた複数の文を言った順に切り分ける", () => {
		const splitter = new SentenceSplitter();

		expect(splitter.push("はい。そうです？うん!本当?ラララ♪")).toEqual([
			"はい。",
			"そうです？",
			"うん!",
			"本当?",
		]);
		expect(splitter.flush()).toBe("ラララ♪");
	});

	it("続いた文末の記号と閉じ括弧は同じ文に含める", () => {
		const splitter = new SentenceSplitter();

		expect(splitter.push("「本当に！？」って言った。（えっ。）次")).toEqual([
			"「本当に！？」",
			"って言った。",
			"（えっ。）",
		]);
		expect(splitter.flush()).toBe("次");
	});

	it("改行も文の区切りにし、前後の空白を除いて空の文は返さない", () => {
		const splitter = new SentenceSplitter();

		expect(splitter.push("  一行目\n\n  \n二行目。 \n")).toEqual(["一行目", "二行目。"]);
	});

	it("半角のピリオドや三点リーダーでは切らない", () => {
		const splitter = new SentenceSplitter();

		expect(splitter.push("円周率は3.14で…")).toEqual([]);
		expect(splitter.flush()).toBe("円周率は3.14で…");
	});

	it("flush は文末の記号のない残りを返して空にし、残りがなければ undefined を返す", () => {
		const splitter = new SentenceSplitter();
		splitter.push("終わり。途中");

		expect(splitter.flush()).toBe("途中");
		expect(splitter.flush()).toBeUndefined();
		splitter.push("   ");
		expect(splitter.flush()).toBeUndefined();
	});
});
