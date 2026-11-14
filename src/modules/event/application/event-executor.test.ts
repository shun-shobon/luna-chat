import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import type {
	AgentInputMessage,
	AgentRunResult,
	AgentSession,
	AgentSessionPhase,
} from "../../agent/ports/outbound/agent-session-port";
import { createRecordingLogger } from "../../observability/testing/recording-logger";
import type { OpenAgentSession } from "../../tool/ports/agent-session-factory-port";
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

describe("EventExecutor", () => {
	it("イベントとタスク一覧を入力にセッションを実行し、完了後にツールを解放してから閉じる", async () => {
		const harness = createHarness();

		const execution = harness.executor.execute(event);
		await vi.waitFor(() => expect(harness.session.runs).toHaveLength(1));
		harness.session.finish({ status: "completed", finalText: "done" });

		await expect(execution).resolves.toEqual({ status: "completed" });
		expect(harness.openSession).toHaveBeenCalledExactlyOnceWith({
			kind: "event",
			eventId: event.id,
			eventType: event.type,
		});
		expect(harness.session.runs[0]).toEqual([
			{ kind: "event", text: JSON.stringify(event) },
			{ kind: "task_board", text: JSON.stringify([{ id: "task-1" }]) },
		]);
		expect(harness.calls).toEqual(["release:owner-1", "close"]);
		expect(harness.logs).toContainEqual({
			level: "info",
			event: "event.execution_completed",
			context: { eventId: event.id },
			details: { sessionId: "session-1" },
		});
	});

	it("実行開始後、完了を待たずにcallbackを呼ぶ", async () => {
		const harness = createHarness();
		const afterRunStarted = vi.fn(async () => {
			harness.calls.push("afterRunStarted");
		});

		const execution = harness.executor.execute(event, afterRunStarted);
		await vi.waitFor(() => expect(afterRunStarted).toHaveBeenCalledOnce());
		expect(harness.calls).toEqual(["afterRunStarted"]);
		harness.session.finish({ status: "completed", finalText: null });

		await expect(execution).resolves.toEqual({ status: "completed" });
	});

	it.each<[string, AgentRunResult, string]>([
		[
			"失敗",
			{ status: "failed", reason: "usage_limit", message: "limit reached" },
			"usage_limit: limit reached",
		],
		["中断", { status: "aborted" }, "Agent run was aborted"],
	])("実行が%sで終わったら失敗を返し、セッションを閉じる", async (_label, result, message) => {
		const harness = createHarness();

		const execution = harness.executor.execute(event);
		await vi.waitFor(() => expect(harness.session.runs).toHaveLength(1));
		harness.session.finish(result);

		const outcome = await execution;
		expect(outcome.status === "failed" && String(outcome.error)).toBe(`Error: ${message}`);
		expect(harness.calls).toEqual(["release:owner-1", "close"]);
		expect(harness.logs).toContainEqual({
			level: "error",
			event: "event.execution_failed",
			context: { eventId: event.id },
			details: { error: expect.any(Error), eventSource: event.source, eventType: event.type },
		});
	});

	it("runの例外を失敗として返し、セッションを閉じる", async () => {
		const failure = new Error("session is broken");
		const harness = createHarness();
		harness.session.run.mockRejectedValueOnce(failure);

		await expect(harness.executor.execute(event)).resolves.toEqual({
			error: failure,
			status: "failed",
		});
		expect(harness.calls).toEqual(["release:owner-1", "close"]);
	});

	it("callbackの例外を失敗として返し、セッションを閉じる", async () => {
		const failure = new Error("callback failed");
		const harness = createHarness();

		const outcome = await harness.executor.execute(event, async () => {
			throw failure;
		});

		expect(outcome).toEqual({ error: failure, status: "failed" });
		expect(harness.calls).toEqual(["release:owner-1", "close"]);
	});

	it("セッションを開けなければ失敗を返し、解放も close もしない", async () => {
		const failure = new Error("open failed");
		const harness = createHarness();
		harness.openSession.mockRejectedValueOnce(failure);

		await expect(harness.executor.execute(event)).resolves.toEqual({
			error: failure,
			status: "failed",
		});
		expect(harness.calls).toEqual([]);
		expect(harness.executor.snapshot()).toEqual([]);
	});

	it("ツール解放とcloseの失敗を記録し、実行結果を変えない", async () => {
		const releaseFailure = new Error("release failed");
		const closeFailure = new Error("close failed");
		const harness = createHarness();
		harness.releaseTools.mockRejectedValueOnce(releaseFailure);
		harness.session.close.mockRejectedValueOnce(closeFailure);

		const execution = harness.executor.execute(event);
		await vi.waitFor(() => expect(harness.session.runs).toHaveLength(1));
		harness.session.finish({ status: "completed", finalText: null });

		await expect(execution).resolves.toEqual({ status: "completed" });
		expect(harness.session.close).toHaveBeenCalledOnce();
		expect(harness.logs).toContainEqual({
			level: "error",
			event: "event.operation_failed",
			context: { eventId: event.id },
			details: { error: releaseFailure, operation: "tools/release" },
		});
		expect(harness.logs).toContainEqual({
			level: "error",
			event: "event.operation_failed",
			context: { eventId: event.id },
			details: { error: closeFailure, operation: "session/close" },
		});
	});

	it("実行失敗後に解放とcloseも失敗しても元の失敗を返す", async () => {
		const runFailure = new Error("run failed");
		const harness = createHarness();
		harness.session.run.mockRejectedValueOnce(runFailure);
		harness.releaseTools.mockRejectedValueOnce(new Error("release failed"));
		harness.session.close.mockRejectedValueOnce(new Error("close failed"));

		await expect(harness.executor.execute(event)).resolves.toEqual({
			error: runFailure,
			status: "failed",
		});
	});

	it("実行中のイベントをフェーズ付きで一覧し、終わったら外す", async () => {
		const opened = createDeferred<void>();
		const harness = createHarness();
		harness.openSession.mockImplementationOnce(async () => {
			await opened.promise;
			return { ownerId: "owner-1", session: harness.session };
		});
		const execution = harness.executor.execute(event);
		const base = {
			eventId: "sensor-event-1",
			eventSource: "test/sensor",
			eventType: "test.sensor.changed.v1",
			startedAt: "2026-08-09T03:00:01.000Z",
			subject: "sensor.temperature",
		};

		await vi.waitFor(() => expect(harness.openSession).toHaveBeenCalledOnce());
		expect(harness.executor.snapshot()).toEqual([{ ...base, phase: "opening", sessionId: null }]);
		opened.resolve();
		await vi.waitFor(() => expect(harness.session.runs).toHaveLength(1));
		expect(harness.executor.snapshot()).toEqual([
			{ ...base, phase: "running", sessionId: "session-1" },
		]);
		harness.session.phase = "retry_wait";
		expect(harness.executor.snapshot()).toMatchObject([{ phase: "retry_wait" }]);
		harness.session.phase = "compacting";
		expect(harness.executor.snapshot()).toMatchObject([{ phase: "compacting" }]);
		harness.session.phase = "running";
		harness.session.finish({ status: "completed", finalText: null });

		await execution;
		expect(harness.executor.snapshot()).toEqual([]);
	});

	it("afterRunStartedが失敗したら実行を中断し、終わりを待ってから失敗を返す", async () => {
		const harness = createHarness();
		const outcome = await harness.executor.execute(event, async () => {
			throw new Error("job removal failed");
		});

		expect(harness.session.abort).toHaveBeenCalledOnce();
		expect(outcome.status === "failed" && String(outcome.error)).toBe("Error: job removal failed");
		expect(harness.calls).toEqual(["release:owner-1", "close"]);
	});
});

function createHarness() {
	const calls: string[] = [];
	const session = createFakeSession(calls);
	const openSession: Mock<OpenAgentSession> = vi.fn(async () => ({ ownerId: "owner-1", session }));
	const releaseTools = vi.fn(async (ownerId: string) => {
		calls.push(`release:${ownerId}`);
	});
	const logger = createRecordingLogger();
	const executor = new EventExecutor({
		logger,
		now: () => new Date("2026-08-09T03:00:01Z"),
		openSession,
		releaseTools,
		tasks: { listAll: () => [{ id: "task-1" }] },
	});
	return { calls, executor, logs: logger.entries, openSession, releaseTools, session };
}

type FakeSession = {
	phase: AgentSessionPhase;
	runs: (readonly AgentInputMessage[])[];
	finish(result: AgentRunResult): void;
	readonly id: string;
	run: Mock<AgentSession["run"]>;
	steer: Mock<AgentSession["steer"]>;
	abort: Mock<AgentSession["abort"]>;
	setModel: Mock<AgentSession["setModel"]>;
	close: Mock<AgentSession["close"]>;
	status: Mock<AgentSession["status"]>;
};

function createFakeSession(calls: string[]): FakeSession {
	const pending: Array<(result: AgentRunResult) => void> = [];
	const fake: FakeSession = {
		phase: "idle",
		runs: [],
		finish(result: AgentRunResult): void {
			const resolve = pending.shift();
			if (resolve === undefined) throw new Error("No run is pending.");
			resolve(result);
		},
		id: "session-1",
		run: vi.fn<AgentSession["run"]>(async (messages) => {
			fake.runs.push(messages);
			fake.phase = "running";
			const result = await new Promise<AgentRunResult>((resolve) => {
				pending.push(resolve);
			});
			fake.phase = "idle";
			return result;
		}),
		steer: vi.fn<AgentSession["steer"]>(),
		abort: vi.fn<AgentSession["abort"]>(async () => {
			pending.shift()?.({ status: "aborted" });
		}),
		setModel: vi.fn<AgentSession["setModel"]>(),
		close: vi.fn<AgentSession["close"]>(async () => {
			calls.push("close");
		}),
		status: vi.fn<AgentSession["status"]>(() => ({
			id: "session-1",
			kind: "event",
			label: event.type,
			model: { provider: "openai-codex", model: "gpt-6.1-sol", thinking: "medium" },
			phase: fake.phase,
			phaseSince: "2026-08-09T03:00:01.000Z",
			retries: 0,
		})),
	};
	return fake;
}

function createDeferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}
