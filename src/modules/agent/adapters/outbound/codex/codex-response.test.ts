import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { parseModelList, parseThreadList } from "./codex-response";

describe("Codex response parser", () => {
	it("model/listのモデルと対応強度を検証する", () => {
		expect(
			parseModelList({
				data: [
					{
						model: "gpt-6-sol",
						displayName: "GPT-6 Sol",
						hidden: false,
						supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
					},
				],
				nextCursor: null,
			}),
		).toEqual({
			data: [
				{ model: "gpt-6-sol", displayName: "GPT-6 Sol", supportedReasoningEfforts: ["medium"] },
			],
			nextCursor: null,
		});
		expect(() => parseModelList({ data: [{ model: 1 }], nextCursor: null })).toThrow(ZodError);
	});

	it("updatedAtがないthread summaryを受理する", () => {
		expect(
			parseThreadList({
				backwardsCursor: null,
				data: [{ id: "thread-1" }],
				nextCursor: null,
			}),
		).toEqual({ data: [{ id: "thread-1" }] });
	});
});
