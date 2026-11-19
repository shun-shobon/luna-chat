import { describe, expect, it } from "vitest";

import { voiceFrontInstructions } from "./voice-front-instructions";

describe("voiceFrontInstructions", () => {
	it("絵文字を読む TTS では、感情と音の絵文字の使い方を指示する", () => {
		expect(voiceFrontInstructions({ emoji: true })).toMatchSnapshot();
	});

	it("絵文字を読まない TTS では、絵文字を書かせない", () => {
		const instructions = voiceFrontInstructions({ emoji: false });

		expect(instructions).toContain("without Markdown, emoji, URLs");
		expect(instructions).not.toContain("😊");
	});
});
