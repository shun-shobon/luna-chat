import { describe, expect, it } from "vitest";

import { AssistResponseRegistry } from "./assist-response-registry";

describe("AssistResponseRegistry", () => {
	it("respondの時点で応答待ちを解決し、後のcompleteは何もしない", async () => {
		const registry = new AssistResponseRegistry();
		const outcome = registry.register("request-1");

		registry.respond("request-1", "消したよ", true);
		registry.complete("request-1", false);

		await expect(outcome).resolves.toEqual({
			kind: "response",
			speech: "消したよ",
			continueConversation: true,
		});
	});

	it("応答待ちでないリクエストや2回目のrespondはエラーにする", () => {
		const registry = new AssistResponseRegistry();
		void registry.register("request-1");
		registry.respond("request-1", "はい", false);

		expect(() => registry.respond("request-1", "もう一度", false)).toThrow(
			"Assist request is not waiting for a response: request-1.",
		);
		expect(() => registry.respond("unknown", "はい", false)).toThrow(
			"Assist request is not waiting for a response: unknown.",
		);
	});

	it.each([
		[true, { kind: "response", speech: null, continueConversation: false }],
		[false, { kind: "failed" }],
	])("respondなしでcomplete(%s)なら%oで解決する", async (succeeded, expected) => {
		const registry = new AssistResponseRegistry();
		const outcome = registry.register("request-1");

		registry.complete("request-1", succeeded);

		await expect(outcome).resolves.toEqual(expected);
	});

	it("failAllで応答待ちをすべて失敗にする", async () => {
		const registry = new AssistResponseRegistry();
		const first = registry.register("request-1");
		const second = registry.register("request-2");

		registry.failAll();

		await expect(first).resolves.toEqual({ kind: "failed" });
		await expect(second).resolves.toEqual({ kind: "failed" });
	});
});
