import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentTool } from "../../agent/ports/outbound/agent-session-port";
import { createRecordingLogger } from "../../observability/testing/recording-logger";
import { createToolSet } from "../application/tool-set";
import { createWaitToolProvider } from "./wait-tool-provider";

const origin = { kind: "event", eventId: "event-1", eventType: "test.v1" } as const;

afterEach(() => vi.useRealTimers());

describe("wait tool", () => {
	it("指定した秒数だけ待ってから待機秒数を返す", async () => {
		vi.useFakeTimers();
		const wait = bindWait(
			createToolSet([createWaitToolProvider()], createRecordingLogger()),
			"owner-1",
		);
		const execution = wait.execute({ duration_seconds: 60 }, new AbortController().signal);
		const settled = track(execution);

		await vi.advanceTimersByTimeAsync(59_999);
		expect(settled()).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(execution).resolves.toEqual({
			text: JSON.stringify({ waited_seconds: 60 }),
			images: [],
			isError: false,
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("同じ実行元のreleaseで待機を打ち切り、他の実行元の待機は続ける", async () => {
		vi.useFakeTimers();
		const toolSet = createToolSet([createWaitToolProvider()], createRecordingLogger());
		const cancelled = bindWait(toolSet, "owner-1").execute(
			{ duration_seconds: 60 },
			new AbortController().signal,
		);
		const continuing = bindWait(toolSet, "owner-2").execute(
			{ duration_seconds: 60 },
			new AbortController().signal,
		);
		const settled = track(continuing);

		await toolSet.release("owner-1");

		await expect(cancelled).resolves.toEqual({
			text: "Wait was cancelled",
			images: [],
			isError: true,
		});
		await vi.advanceTimersByTimeAsync(59_999);
		expect(settled()).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(continuing).resolves.toMatchObject({ isError: false });
	});

	it("実行中のabortで待機を打ち切り、タイマーを残さない", async () => {
		vi.useFakeTimers();
		const wait = bindWait(
			createToolSet([createWaitToolProvider()], createRecordingLogger()),
			"owner-1",
		);
		const controller = new AbortController();
		const execution = wait.execute({ duration_seconds: 60 }, controller.signal);

		controller.abort();

		await expect(execution).resolves.toEqual({
			text: "Wait was aborted",
			images: [],
			isError: true,
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("abort済みのsignalでは待たずに打ち切る", async () => {
		vi.useFakeTimers();
		const wait = bindWait(
			createToolSet([createWaitToolProvider()], createRecordingLogger()),
			"owner-1",
		);
		const controller = new AbortController();
		controller.abort();

		await expect(wait.execute({ duration_seconds: 60 }, controller.signal)).resolves.toMatchObject({
			text: "Wait was aborted",
			isError: true,
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([0, -1, 1.5, "60", 2_147_484])("不正な秒数 %s を待たずに拒否する", async (duration) => {
		vi.useFakeTimers();
		const wait = bindWait(
			createToolSet([createWaitToolProvider()], createRecordingLogger()),
			"owner-1",
		);

		await expect(
			wait.execute({ duration_seconds: duration }, new AbortController().signal),
		).resolves.toMatchObject({ isError: true });
		expect(vi.getTimerCount()).toBe(0);
	});
});

function bindWait(toolSet: ReturnType<typeof createToolSet>, ownerId: string): AgentTool {
	const tool = toolSet.bind({ ownerId, origin }).find((candidate) => candidate.name === "wait");
	if (tool === undefined) throw new Error("wait tool is missing");
	return tool;
}

function track(promise: Promise<unknown>): () => boolean {
	let settled = false;
	void promise.finally(() => {
		settled = true;
	});
	return () => settled;
}
