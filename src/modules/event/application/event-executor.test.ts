import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { z } from "zod";

import type {
	AgentRuntimePort,
	AgentThreadInput,
	AgentTurnResult,
} from "../../agent/ports/outbound/agent-runtime-port";
import type { EffectRequest, EffectResult } from "../../effect/domain/effect";
import type { EffectBatchPort } from "../../effect/ports/effect-batch-port";
import type { EffectOutputContract } from "../../effect/ports/effect-output-contract";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type { LunaEvent } from "../domain/luna-event";
import { EventExecutor } from "./event-executor";

const event: LunaEvent = {
	id: "sensor-event-1",
	type: "test.sensor.changed.v1",
	source: "test/sensor",
	subject: "sensor.temperature",
	occurredAt: "2026-08-09T03:00:00Z",
	data: { from: 23, to: 24 },
};

const threadInput: AgentThreadInput = {
	executionOwnerId: "owner-1",
	baseInstructions: "Luna",
	config: {},
	cwd: "/workspace",
	developerInstructions: "protocol",
};

const effectOutput: EffectOutputContract = {
	jsonSchema: { type: "object" },
	parse: (text) => ({
		effects: z
			.strictObject({
				effects: z.array(z.strictObject({ type: z.string(), input: z.json() })),
			})
			.parse(JSON.parse(text))
			.effects.map(({ type, input }): EffectRequest => ({
				type,
				input,
				target: input,
				run: async () => input,
			})),
	}),
};

describe("EventExecutor", () => {
	it("turn開始後にcallbackを呼び、完了後にthreadをarchiveする", async () => {
		const turn = createDeferred<AgentTurnResult>();
		const calls: string[] = [];
		const harness = createHarness([], calls);
		harness.startTurn.mockImplementationOnce(async () => {
			calls.push("start");
			return { turnId: "turn-1", completion: turn.promise };
		});

		const execution = harness.executor.execute(event, async () => {
			calls.push("afterTurnStarted");
		});

		await vi.waitFor(() => {
			expect(calls).toEqual(["open", "start", "afterTurnStarted"]);
		});
		turn.resolve(completed([]));

		await expect(execution).resolves.toEqual({ status: "completed" });
		expect(calls).toEqual(["open", "start", "afterTurnStarted", "archive"]);
	});

	it("Eventをthread openからEffect実行、release、archiveまで処理する", async () => {
		const calls: string[] = [];
		const harness = createHarness([completed([{ type: "fake.record", input: "changed" }])], calls);

		await expect(harness.executor.execute(event)).resolves.toEqual({ status: "completed" });

		expect(harness.openThread).toHaveBeenCalledWith(threadInput);
		expect(harness.startTurn).toHaveBeenCalledWith("thread-1", {
			input: JSON.stringify({ source: "event", event }),
			outputSchema: effectOutput.jsonSchema,
		});
		expect(harness.executeEffects).toHaveBeenCalledWith(
			[expect.objectContaining({ type: "fake.record", input: "changed" })],
			"owner-1",
		);
		expect(harness.release).toHaveBeenCalledWith("owner-1");
		expect(calls).toEqual(["open", "archive"]);
	});

	it.each<[string, EffectResult]>([
		["待機", { index: 0, type: "system.wait", target: null, success: true, value: 60 }],
		["Effect失敗", { index: 0, type: "fake.record", target: "x", success: false, error: "e" }],
	])("%s結果を同じthreadへfollow-upし、成功後にarchiveする", async (_label, result) => {
		const harness = createHarness([completed([{ type: result.type, input: null }]), completed([])]);
		harness.executeEffects.mockResolvedValueOnce([result]);

		await expect(harness.executor.execute(event)).resolves.toEqual({ status: "completed" });

		expect(harness.startTurn).toHaveBeenCalledTimes(2);
		expect(harness.startTurn.mock.calls[1]?.[0]).toBe("thread-1");
		expect(JSON.parse(harness.startTurn.mock.calls[1]?.[1].input ?? "null")).toEqual({
			source: "effect_results",
			results: [result],
		});
		expect(harness.archiveThread).toHaveBeenCalledWith("thread-1");
	});

	it.each<AgentTurnResult>([
		{ status: "completed", outputText: "{" },
		{ status: "failed", errorMessage: "turn failed" },
		{ status: "interrupted" },
	])("turn結果が$statusで処理できなくてもthreadをarchiveする", async (turn) => {
		const harness = createHarness([turn]);

		const result = await harness.executor.execute(event);

		expect(result.status).toBe("failed");
		expect(harness.archiveThread).toHaveBeenCalledWith("thread-1");
		expect(harness.executeEffects).not.toHaveBeenCalled();
	});

	it("turn開始失敗時も作成済みthreadをarchiveする", async () => {
		const failure = new Error("turn failed");
		const harness = createHarness([]);
		harness.startTurn.mockRejectedValueOnce(failure);

		await expect(harness.executor.execute(event)).resolves.toEqual({
			error: failure,
			status: "failed",
		});
		expect(harness.archiveThread).toHaveBeenCalledWith("thread-1");
		expect(harness.log).toHaveBeenCalledWith(
			"error",
			"event.execution_failed",
			{ threadId: "thread-1" },
			{ error: failure, eventSource: "test/sensor", eventType: "test.sensor.changed.v1" },
		);
	});

	it("thread作成失敗時はarchiveしない", async () => {
		const failure = new Error("open failed");
		const harness = createHarness([]);
		harness.openThread.mockRejectedValueOnce(failure);

		await expect(harness.executor.execute(event)).resolves.toEqual({
			error: failure,
			status: "failed",
		});
		expect(harness.archiveThread).not.toHaveBeenCalled();
	});

	it("archive失敗をlogし、完了結果を変更しない", async () => {
		const archiveFailure = new Error("archive failed");
		const harness = createHarness([completed([])]);
		harness.archiveThread.mockRejectedValueOnce(archiveFailure);

		await expect(harness.executor.execute(event)).resolves.toEqual({ status: "completed" });
		expect(harness.log).toHaveBeenCalledWith(
			"error",
			"event.thread_archive_failed",
			{ threadId: "thread-1" },
			{ error: archiveFailure },
		);
	});

	it("実行失敗後のarchiveも失敗した場合に元の失敗結果を維持する", async () => {
		const turnFailure = new Error("turn failed");
		const harness = createHarness([]);
		harness.startTurn.mockRejectedValueOnce(turnFailure);
		harness.archiveThread.mockRejectedValueOnce(new Error("archive failed"));

		await expect(harness.executor.execute(event)).resolves.toEqual({
			error: turnFailure,
			status: "failed",
		});
	});

	it("Effect実行中のconnection lossでowner resourceをreleaseし、旧threadへfollow-upもarchiveもしない", async () => {
		const effectResults = createDeferred<readonly EffectResult[]>();
		const harness = createHarness([completed([{ type: "fake.record", input: "first" }])]);
		harness.executeEffects.mockImplementationOnce(async () => await effectResults.promise);
		const execution = harness.executor.execute(event);
		await vi.waitFor(() => expect(harness.executeEffects).toHaveBeenCalledOnce());

		harness.executor.connectionLost();
		await vi.waitFor(() => expect(harness.release).toHaveBeenCalledWith("owner-1"));
		effectResults.resolve([
			{ index: 0, type: "system.wait", target: null, success: true, value: null },
		]);

		const result = await execution;
		expect(result.status === "failed" && String(result.error)).toContain("connection was lost");
		expect(harness.startTurn).toHaveBeenCalledOnce();
		expect(harness.archiveThread).not.toHaveBeenCalled();
	});
});

function createHarness(turns: readonly AgentTurnResult[], calls: string[] = []) {
	let index = 0;
	const openThread = vi.fn<AgentRuntimePort["openThread"]>(async () => {
		calls.push("open");
		return "thread-1";
	});
	const startTurn = vi.fn<AgentRuntimePort["startTurn"]>(async () => {
		const completion = turns[index];
		if (completion === undefined) throw new Error("No fake turn result remains.");
		index += 1;
		return { turnId: `turn-${String(index)}`, completion: Promise.resolve(completion) };
	});
	const archiveThread = vi.fn<AgentRuntimePort["archiveThread"]>(async () => {
		calls.push("archive");
	});
	const agent: AgentRuntimePort = {
		archiveThread,
		deleteThread: vi.fn(async () => {}),
		listThreads: vi.fn(async () => ({ data: [] })),
		listModels: vi.fn(async () => []),
		openThread,
		interruptTurn: vi.fn(async () => {}),
		startTurn,
		steerTurn: vi.fn(async () => {}),
	};
	const executeEffects: Mock<EffectBatchPort["execute"]> = vi.fn(async (effects) =>
		effects.map((request, effectIndex) => ({
			index: effectIndex,
			type: request.type,
			target: request.target,
			success: true as const,
			value: request.input,
		})),
	);
	const release = vi.fn<EffectBatchPort["release"]>(async () => {});
	const log = vi.fn<LoggerPort["log"]>();
	const executor = new EventExecutor({
		agent,
		createThreadInput: async () => threadInput,
		effectOutput,
		effects: { execute: executeEffects, release },
		logger: { log },
	});
	return { archiveThread, executeEffects, executor, log, openThread, release, startTurn };
}

function completed(
	effects: readonly Readonly<{ type: string; input: unknown }>[],
): AgentTurnResult {
	return { status: "completed", outputText: JSON.stringify({ effects }) };
}

function createDeferred<Value>(): {
	promise: Promise<Value>;
	resolve: (value: Value | PromiseLike<Value>) => void;
} {
	let resolve!: (value: Value | PromiseLike<Value>) => void;
	const promise = new Promise<Value>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}
