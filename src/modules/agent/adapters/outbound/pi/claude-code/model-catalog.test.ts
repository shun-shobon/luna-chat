import { describe, expect, it } from "vitest";

import {
	API_ID,
	CLAUDE_CODE_MODELS,
	PROVIDER_ID,
	supportsAdaptiveThinking,
	supportsDisabledThinking,
	supportsNativeToolChanges,
} from "./model-catalog";

describe("CLAUDE_CODE_MODELS", () => {
	it("pi-ai の Anthropic の定義を Claude Code 用に写す", () => {
		expect(CLAUDE_CODE_MODELS.map((model) => model.id)).toEqual([
			"claude-fable-5-2",
			"claude-opus-5-5",
			"claude-sonnet-5-5",
			"claude-haiku-5-5",
		]);
		for (const model of CLAUDE_CODE_MODELS) {
			expect(model).toMatchObject({
				api: API_ID,
				provider: PROVIDER_ID,
				baseUrl: "process://claude-code",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 128_000,
			});
			expect(model).not.toHaveProperty("compat");
		}
		expect(CLAUDE_CODE_MODELS.find((model) => model.id === "claude-opus-5-5")).toMatchObject({
			name: "Claude Opus 5.5",
			reasoning: true,
			input: ["text", "image"],
			thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
		});
	});

	it("pi-ai の定義から思考とツール変更への対応を決める", () => {
		expect(supportsAdaptiveThinking("claude-opus-5-5")).toBe(true);
		expect(supportsDisabledThinking("claude-opus-5-5")).toBe(false);
		expect(supportsDisabledThinking("claude-haiku-5-5")).toBe(true);
		expect(supportsNativeToolChanges("claude-fable-5-2")).toBe(true);
	});

	it("一覧に無いモデルは例外にする", () => {
		expect(() => supportsAdaptiveThinking("claude-sonnet-5")).toThrow(
			"Unknown Claude Code model: claude-sonnet-5",
		);
	});
});
