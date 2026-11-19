import { describe, expect, it } from "vitest";

import { readRecognition } from "./sherpa-transcriber";

describe("readRecognition", () => {
	it("SenseVoice が声と判定した結果は本文だけを使う", () => {
		expect(
			readRecognition({
				text: " こんにちは ",
				lang: "<|ja|>",
				emotion: "<|NEUTRAL|>",
				event: "<|Speech|>",
			}),
		).toEqual({ text: "こんにちは", nonVerbal: false });
	});

	it("笑い声や咳などの判定は声でないものとして返す", () => {
		expect(readRecognition({ text: "", event: "<|Laughter|>" })).toEqual({
			text: "",
			nonVerbal: true,
		});
		expect(readRecognition({ text: "えっ", event: "Cough" })).toEqual({
			text: "えっ",
			nonVerbal: true,
		});
	});

	it("音の種類を判定しない認識器の結果は声として扱う", () => {
		expect(readRecognition({ text: "うん", event: "" })).toEqual({
			text: "うん",
			nonVerbal: false,
		});
		expect(readRecognition({ text: "うん" })).toEqual({ text: "うん", nonVerbal: false });
	});

	it("本文のない結果は不正として断る", () => {
		expect(() => readRecognition({ event: "<|Speech|>" })).toThrow(/text/u);
	});
});
