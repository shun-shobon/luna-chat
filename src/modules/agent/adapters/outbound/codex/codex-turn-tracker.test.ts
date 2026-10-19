import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { CodexTurnTracker, TurnCorrelationError } from "./codex-turn-tracker";

describe("CodexTurnTracker", () => {
	it("final_answer のraw textを返して完了する", async () => {
		const tracker = new CodexTurnTracker("thread-1");
		tracker.bindTurnId("turn-1");
		tracker.handleNotification({
			method: "item/completed",
			params: {
				completedAtMs: 1,
				item: {
					phase: "final_answer",
					text: '{"actions":[{"kind":"start_typing","target":{"kind":"channel","channelId":"123"}}]}',
					type: "agentMessage",
				},
				threadId: "thread-1",
				turnId: "turn-1",
			},
		});
		tracker.handleNotification({
			method: "turn/completed",
			params: {
				threadId: "thread-1",
				turn: { error: null, id: "turn-1", status: "completed" },
			},
		});

		await expect(tracker.completion).resolves.toEqual({
			outputTexts: [
				'{"actions":[{"kind":"start_typing","target":{"kind":"channel","channelId":"123"}}]}',
			],
			status: "completed",
		});
	});

	it("steer後に同じturnで出た複数の final_answer を出た順にすべて返す", async () => {
		const tracker = new CodexTurnTracker("thread-1");
		tracker.bindTurnId("turn-1");
		for (const text of ["first", "second"]) {
			tracker.handleNotification({
				method: "item/completed",
				params: {
					completedAtMs: 1,
					item: { phase: "final_answer", text, type: "agentMessage" },
					threadId: "thread-1",
					turnId: "turn-1",
				},
			});
		}
		tracker.handleNotification({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { error: null, id: "turn-1", status: "completed" } },
		});

		await expect(tracker.completion).resolves.toEqual({
			outputTexts: ["first", "second"],
			status: "completed",
		});
	});

	it.each([
		["serverOverloaded", true],
		[{ responseStreamDisconnected: { httpStatusCode: null } }, true],
		["usageLimitExceeded", false],
		[null, false],
	])("Codexのエラー種別 %j を再試行可否 %s として返す", async (codexErrorInfo, retryable) => {
		const tracker = new CodexTurnTracker("thread-1");
		tracker.bindTurnId("turn-1");
		tracker.handleNotification({
			method: "turn/completed",
			params: {
				threadId: "thread-1",
				turn: {
					error: { codexErrorInfo, message: "Selected model is at capacity." },
					id: "turn-1",
					status: "failed",
				},
			},
		});

		await expect(tracker.completion).resolves.toEqual({
			errorMessage: "Selected model is at capacity.",
			retryable,
			status: "failed",
		});
	});

	it("partial_answer は最終出力として扱わず、後続の final_answer を返す", async () => {
		const tracker = new CodexTurnTracker("thread-1");
		tracker.bindTurnId("turn-1");
		for (const [phase, text] of [
			["partial_answer", "partial"],
			["final_answer", "final"],
		] as const) {
			tracker.handleNotification({
				method: "item/completed",
				params: {
					completedAtMs: 1,
					item: { phase, text, type: "agentMessage" },
					threadId: "thread-1",
					turnId: "turn-1",
				},
			});
		}
		tracker.handleNotification({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { error: null, id: "turn-1", status: "completed" } },
		});

		await expect(tracker.completion).resolves.toEqual({
			outputTexts: ["final"],
			status: "completed",
		});
	});

	it("同一 thread の異なる turn id を拒否する", () => {
		const tracker = new CodexTurnTracker("thread-1");
		tracker.bindTurnId("turn-1");

		expect(() =>
			tracker.handleNotification({
				method: "item/completed",
				params: {
					completedAtMs: 1,
					item: { type: "plan" },
					threadId: "thread-1",
					turnId: "turn-2",
				},
			}),
		).toThrow(TurnCorrelationError);
	});

	it("turn 固有 delta の相関 ID 欠落を拒否する", () => {
		const tracker = new CodexTurnTracker("thread-1");
		tracker.bindTurnId("turn-1");

		expect(() =>
			tracker.handleNotification({
				method: "item/reasoning/textDelta",
				params: { threadId: "thread-1" },
			}),
		).toThrow(ZodError);
	});

	it("final_answer がJSONでなくても解釈せずraw textを返す", async () => {
		const tracker = new CodexTurnTracker("thread-1");
		tracker.bindTurnId("turn-1");
		tracker.handleNotification({
			method: "item/completed",
			params: {
				item: { phase: "final_answer", text: "not-json", type: "agentMessage" },
				threadId: "thread-1",
				turnId: "turn-1",
			},
		});
		tracker.handleNotification({
			method: "turn/completed",
			params: {
				threadId: "thread-1",
				turn: { error: null, id: "turn-1", status: "completed" },
			},
		});

		await expect(tracker.completion).resolves.toEqual({
			outputTexts: ["not-json"],
			status: "completed",
		});
	});

	it("request_user_input を当該 turn の failure にする", async () => {
		const tracker = new CodexTurnTracker("thread-1");
		tracker.bindTurnId("turn-1");

		tracker.markUserInputRequested("turn-1");
		tracker.handleNotification({
			method: "turn/completed",
			params: {
				threadId: "thread-1",
				turn: { error: null, id: "turn-1", status: "failed" },
			},
		});
		await expect(tracker.completion).resolves.toMatchObject({ status: "failed" });
	});
});
