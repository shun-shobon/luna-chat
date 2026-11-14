import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import type {
	AgentInputMessage,
	AgentRunResult,
	AgentSession,
} from "../../agent/ports/outbound/agent-session-port";
import type { LunaEvent } from "../../event/domain/luna-event";
import { createRecordingLogger } from "../../observability/testing/recording-logger";
import type { ToolOrigin } from "../../tool/domain/tool";
import type { OpenAgentSession } from "../../tool/ports/agent-session-factory-port";
import type { Task, TaskOrigin, TaskReportKind } from "../domain/task";
import type { TaskDeliveryPort } from "../ports/task-delivery-port";
import { TaskService } from "./task-service";

const channelOrigin = {
	kind: "conversation",
	session: {
		key: "discord:guild_channel:1:2",
		source: "discord/main",
		context: { kind: "guild_channel", guildId: "1", channelId: "2" },
	},
} as const satisfies ToolOrigin;
const dmOrigin = {
	kind: "conversation",
	session: {
		key: "discord:dm:3:4",
		source: "discord/main",
		context: { kind: "dm", channelId: "3", userId: "4" },
	},
} as const satisfies ToolOrigin;
const heartbeatOrigin = {
	kind: "event",
	eventId: "event-1",
	eventType: "system.heartbeat.fired.v1",
} as const satisfies ToolOrigin;

const COMPLETED: AgentRunResult = { status: "completed", finalText: null };

describe("TaskService", () => {
	it("作成したtaskを専用セッションで実行し、resultを起点へ配送してセッションを閉じる", async () => {
		const harness = await createHarness();

		const task = await harness.service.create(channelOrigin, {
			title: "調査",
			instructions: "pi の変更点を調べる",
		});
		expect(task.status).toBe("queued");
		await harness.waitForRuns(1);

		expect(harness.openSession).toHaveBeenCalledWith({ kind: "task", taskId: task.id });
		expect(harness.runs[0]?.messages).toEqual([
			{
				kind: "task_assignment",
				text: JSON.stringify({
					id: task.id,
					title: "調査",
					instructions: "pi の変更点を調べる",
					origin: channelOrigin.session.key,
					created_at: "2026-10-19T00:00:00.000Z",
					attempt: 1,
					previous_reports: [],
					messages: [],
				}),
			},
		]);
		await harness.report(task.id, "result", "まとめた", ["/workspace/report.md"]);
		harness.finishRun(0);

		await vi.waitFor(() => expect(harness.sessions[0]?.close).toHaveBeenCalledOnce());
		expect(harness.calls).toEqual(["release:owner-1", "close:session-1"]);
		expect(harness.latest(task.id)).toMatchObject({ status: "completed", attempts: 1 });
		expect(harness.delivered).toHaveLength(1);
		expect(harness.delivered[0]?.origin).toEqual(channelOrigin);
		expect(harness.delivered[0]?.event).toMatchObject({
			type: "luna.task.reported.v1",
			source: "luna/task",
			subject: task.id,
			data: {
				task: { id: task.id, status: "completed" },
				instructions: task.instructions,
				report: { kind: "result", summary: "まとめた", artifacts: ["/workspace/report.md"] },
			},
		});
		await vi.waitFor(() => expect(harness.latest(task.id).reports[0]?.deliveredAt).not.toBeNull());
	});

	it("同時実行数を超えるtaskは先行taskの終了まで待ち、ボードに実行枠の使用数を出す", async () => {
		const harness = await createHarness({ maxConcurrent: 1 });
		const first = await harness.service.create(channelOrigin, input("first"));
		const second = await harness.service.create(channelOrigin, input("second"));
		await harness.waitForRuns(1);

		expect(harness.service.snapshot()).toMatchObject({ maxConcurrent: 1, running: 1 });
		expect(harness.latest(second.id).status).toBe("queued");
		await harness.report(first.id, "result", "done");
		harness.finishRun(0);
		await harness.waitForRuns(2);

		expect(harness.latest(first.id).status).toBe("completed");
		expect(taskIdOf(harness.runs[1]?.messages)).toBe(second.id);
		expect(harness.runs[1]?.sessionId).toBe("session-2");
	});

	it("progressは配送せず、milestoneは配送して作業を続ける", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("long"));
		await harness.waitForRuns(1);

		await expect(harness.report(task.id, "progress", "半分")).resolves.toEqual({
			seq: 1,
			status: "running",
		});
		await harness.report(task.id, "milestone", "重要な発見");

		await vi.waitFor(() => expect(harness.delivered).toHaveLength(1));
		expect(harness.delivered[0]?.event.data).toMatchObject({ report: { kind: "milestone" } });
		expect(harness.service.listFor({ kind: "event" })[0]).toMatchObject({
			id: task.id,
			status: "running",
			latest_report: { kind: "milestone", summary: "重要な発見" },
		});
	});

	it("終了の報告なしで実行が終わったら同じセッションで一度だけtask_checkを送り、それでもなければ失敗を配送する", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("silent"));
		await harness.waitForRuns(1);

		harness.finishRun(0);
		await harness.waitForRuns(2);
		expect(harness.runs[1]).toEqual({
			sessionId: "session-1",
			messages: [{ kind: "task_check", text: JSON.stringify({ task_id: task.id }) }],
		});
		harness.finishRun(1);

		await vi.waitFor(() => expect(harness.latest(task.id).status).toBe("failed"));
		expect(harness.latest(task.id).outcome).toBe(
			"Worker ended without a result, question, or failure report.",
		);
		expect(harness.delivered[0]?.event.data).toMatchObject({
			report: {
				kind: "failure",
				summary: "Worker ended without a result, question, or failure report.",
			},
		});
		expect(harness.runs).toHaveLength(2);
		await vi.waitFor(() => expect(harness.sessions[0]?.close).toHaveBeenCalledOnce());
	});

	it("task_checkの後に終了の報告があれば完了する", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("late"));
		await harness.waitForRuns(1);
		harness.finishRun(0);
		await harness.waitForRuns(2);

		await harness.report(task.id, "result", "done");
		harness.finishRun(1);

		await vi.waitFor(() => expect(harness.sessions[0]?.close).toHaveBeenCalledOnce());
		expect(harness.latest(task.id).status).toBe("completed");
		expect(harness.runs).toHaveLength(2);
	});

	it("questionで待機したセッションを閉じずに保持して実行枠を空け、返答を同じセッションのtask_messageとして渡す", async () => {
		const harness = await createHarness({ maxConcurrent: 1 });
		const task = await harness.service.create(channelOrigin, input("ask"));
		await harness.waitForRuns(1);
		await expect(harness.report(task.id, "question", "どちらにする？")).resolves.toEqual({
			seq: 1,
			status: "waiting_input",
		});
		harness.finishRun(0);
		await vi.waitFor(() => expect(harness.service.snapshot().running).toBe(0));
		const other = await harness.service.create(channelOrigin, input("other"));
		await harness.waitForRuns(2);
		expect(taskIdOf(harness.runs[1]?.messages)).toBe(other.id);
		await harness.report(other.id, "result", "done");
		harness.finishRun(1);
		await vi.waitFor(() => expect(harness.service.snapshot().running).toBe(0));

		expect(harness.sessions[0]?.close).not.toHaveBeenCalled();
		expect(harness.latest(task.id)).toMatchObject({ status: "waiting_input" });
		await expect(harness.service.message(channelOrigin, task.id, "Aで")).resolves.toBe("running");
		await harness.waitForRuns(3);

		expect(harness.runs[2]?.sessionId).toBe("session-1");
		expect(harness.runs[2]?.messages).toHaveLength(1);
		expect(harness.runs[2]?.messages[0]?.kind).toBe("task_message");
		expect(JSON.parse(harness.runs[2]?.messages[0]?.text ?? "")).toEqual({
			task_id: task.id,
			messages: [{ id: expect.any(String), text: "Aで", received_at: "2026-10-19T00:00:00.000Z" }],
		});
		expect(harness.latest(task.id)).toMatchObject({ status: "running", attempts: 1 });
		expect(harness.openSession).toHaveBeenCalledTimes(2);
	});

	it("実行中のmessageをsteerで渡し、配送済みとして記録する", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("steer"));
		await harness.waitForRuns(1);

		await expect(harness.service.message(channelOrigin, task.id, "方針変更")).resolves.toBe(
			"running",
		);

		expect(harness.sessions[0]?.steer).toHaveBeenCalledOnce();
		expect(harness.sessions[0]?.steer.mock.calls[0]?.[0]).toMatchObject({ kind: "task_message" });
		expect(JSON.parse(harness.sessions[0]?.steer.mock.calls[0]?.[0].text ?? "")).toMatchObject({
			task_id: task.id,
			messages: [{ text: "方針変更" }],
		});
		expect(harness.latest(task.id).messages[0]?.deliveredAt).not.toBeNull();
	});

	it("実行の終わり際に届いて渡せなかったmessageは、同じセッションの次の実行で渡す", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("race"));
		await harness.waitForRuns(1);

		harness.finishRun(0);
		// run の finally で実行中フラグが下りた直後、結果を読む前に届く message を再現する。
		await Promise.resolve();
		const messaged = harness.service.message(channelOrigin, task.id, "追加の依頼");
		await harness.waitForRuns(2);
		await messaged;

		expect(harness.sessions[0]?.steer).not.toHaveBeenCalled();
		expect(harness.runs[1]?.sessionId).toBe("session-1");
		expect(harness.runs[1]?.messages[0]?.kind).toBe("task_message");
		expect(JSON.parse(harness.runs[1]?.messages[0]?.text ?? "")).toMatchObject({
			messages: [{ text: "追加の依頼" }],
		});
	});

	it.each<[string, AgentRunResult | Error, string]>([
		[
			"失敗",
			{ status: "failed", reason: "transient_exhausted", message: "overloaded" },
			"transient_exhausted: overloaded",
		],
		["例外", new Error("session crashed"), "session crashed"],
	])("実行の%sはtaskを失敗させて理由を配送する", async (_label, outcome, reason) => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("fail"));
		await harness.waitForRuns(1);

		if (outcome instanceof Error) harness.failRun(0, outcome);
		else harness.finishRun(0, outcome);

		await vi.waitFor(() => expect(harness.latest(task.id).status).toBe("failed"));
		expect(harness.latest(task.id).outcome).toBe(reason);
		expect(harness.delivered[0]?.event.data).toMatchObject({
			report: { kind: "failure", summary: reason },
		});
		await vi.waitFor(() => expect(harness.sessions[0]?.close).toHaveBeenCalledOnce());
	});

	it("セッションを開けなければtaskを失敗させ、次のtaskへ実行枠を渡す", async () => {
		const harness = await createHarness({ maxConcurrent: 1 });
		harness.openSession.mockRejectedValueOnce(new Error("model unavailable"));
		const broken = await harness.service.create(channelOrigin, input("broken"));
		const next = await harness.service.create(channelOrigin, input("next"));

		await harness.waitForRuns(1);

		expect(harness.latest(broken.id)).toMatchObject({
			status: "failed",
			outcome: "model unavailable",
		});
		expect(taskIdOf(harness.runs[0]?.messages)).toBe(next.id);
		expect(harness.logs).toContainEqual({
			level: "error",
			event: "task.run_failed",
			context: { taskId: broken.id },
			details: { error: expect.any(Error) },
		});
	});

	it("実行中taskの取消でツールを解放して実行を中断し、以後の実行をせずにセッションを閉じる", async () => {
		const harness = await createHarness({ maxConcurrent: 1 });
		const task = await harness.service.create(channelOrigin, input("cancel"));
		const next = await harness.service.create(channelOrigin, input("next"));
		await harness.waitForRuns(1);

		await expect(harness.service.cancel(channelOrigin, task.id, "不要")).resolves.toBe("cancelled");

		expect(harness.releaseTools).toHaveBeenCalledWith("owner-1");
		expect(harness.sessions[0]?.abort).toHaveBeenCalledOnce();
		await harness.waitForRuns(2);
		expect(harness.sessions[0]?.close).toHaveBeenCalledOnce();
		expect(taskIdOf(harness.runs[1]?.messages)).toBe(next.id);
		expect(harness.latest(task.id)).toMatchObject({ status: "cancelled", outcome: "不要" });
		expect(harness.delivered).toEqual([]);
		await expect(harness.service.message(channelOrigin, task.id, "やっぱり")).rejects.toThrow(
			"already cancelled",
		);
	});

	it("セッションを開いている間の取消では実行を始めずにセッションを閉じる", async () => {
		const harness = await createHarness();
		const opening = createDeferred<void>();
		harness.openSession.mockImplementationOnce(async (origin) => {
			await opening.promise;
			return harness.createSession(origin);
		});
		const task = await harness.service.create(channelOrigin, input("cancel early"));
		await vi.waitFor(() => expect(harness.openSession).toHaveBeenCalledOnce());

		await harness.service.cancel(channelOrigin, task.id, null);
		opening.resolve();

		await vi.waitFor(() => expect(harness.sessions[0]?.close).toHaveBeenCalledOnce());
		expect(harness.runs).toEqual([]);
		expect(harness.latest(task.id)).toMatchObject({ status: "cancelled", outcome: null });
	});

	it("質問待ちのtaskの取消で保持していたセッションを閉じる", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("ask"));
		await harness.waitForRuns(1);
		await harness.report(task.id, "question", "どちら？");
		harness.finishRun(0);
		await vi.waitFor(() => expect(harness.service.snapshot().running).toBe(0));

		await harness.service.cancel(channelOrigin, task.id, null);

		await vi.waitFor(() => expect(harness.sessions[0]?.close).toHaveBeenCalledOnce());
		expect(harness.calls).toEqual(["release:owner-1", "close:session-1"]);
		expect(harness.runs).toHaveLength(1);
	});

	it("停止時に実行中taskをqueueへ戻して実行を中断し、保持中のセッションも閉じてから終える", async () => {
		const harness = await createHarness();
		const running = await harness.service.create(channelOrigin, input("running"));
		const asking = await harness.service.create(channelOrigin, input("asking"));
		await harness.waitForRuns(2);
		await harness.report(asking.id, "question", "どちら？");
		harness.finishRun(1);
		await vi.waitFor(() => expect(harness.service.snapshot().running).toBe(1));

		await harness.service.drain();

		expect(harness.sessions[0]?.abort).toHaveBeenCalledOnce();
		expect(harness.sessions[0]?.close).toHaveBeenCalledOnce();
		expect(harness.sessions[1]?.close).toHaveBeenCalledOnce();
		expect(harness.latest(running.id).status).toBe("queued");
		expect(harness.latest(asking.id).status).toBe("waiting_input");
		expect(harness.runs).toHaveLength(2);
		await expect(harness.service.create(channelOrigin, input("late"))).rejects.toThrow(
			"intake is stopped",
		);
	});

	it("起動時に実行中だったtaskを次のattemptとして再開し、過去の報告をassignmentへ含める", async () => {
		const harness = await createHarness({
			tasks: [
				storedTask({
					id: "interrupted",
					status: "running",
					attempts: 1,
					reports: [report(1, "milestone", "前半完了", "2026-10-18T23:00:00.000Z")],
				}),
			],
		});

		await harness.waitForRuns(1);

		expect(JSON.parse(harness.runs[0]?.messages[0]?.text ?? "")).toMatchObject({
			id: "interrupted",
			attempt: 2,
			previous_reports: [{ seq: 1, kind: "milestone", summary: "前半完了" }],
		});
		expect(harness.latest("interrupted")).toMatchObject({ status: "running", attempts: 2 });
	});

	it("中断が上限回数に達したtaskは実行せずに失敗させる", async () => {
		const harness = await createHarness({
			tasks: [storedTask({ id: "flaky", status: "running", attempts: 5 })],
		});

		await vi.waitFor(() => expect(harness.latest("flaky").status).toBe("failed"));

		expect(harness.latest("flaky")).toMatchObject({
			attempts: 6,
			outcome: "Task was interrupted 5 times.",
		});
		expect(harness.openSession).not.toHaveBeenCalled();
		expect(harness.delivered[0]?.event.data).toMatchObject({ report: { kind: "failure" } });
	});

	it("起動時に未配送の通知だけを配送し直し、配送できたら配送済みにする", async () => {
		const harness = await createHarness({
			tasks: [
				storedTask({
					id: "answered",
					status: "completed",
					updatedAt: "2026-10-18T23:00:00.000Z",
					reports: [
						report(1, "progress", "途中", null),
						report(2, "milestone", "配送済み", "2026-10-18T22:00:00.000Z"),
						report(3, "result", "done", null),
					],
				}),
			],
		});

		await vi.waitFor(() =>
			expect(harness.latest("answered").reports[2]?.deliveredAt).not.toBeNull(),
		);

		expect(harness.delivered.map((delivery) => delivery.event.data)).toEqual([
			expect.objectContaining({ report: expect.objectContaining({ seq: 3 }) }),
		]);
		expect(harness.latest("answered").reports[0]?.deliveredAt).toBeNull();
	});

	it("配送を拒否された通知と配送に失敗した通知を未配送のまま残す", async () => {
		const harness = await createHarness();
		harness.deliver
			.mockResolvedValueOnce("rejected")
			.mockRejectedValueOnce(new Error("conversation closed"));
		const task = await harness.service.create(channelOrigin, input("reject"));
		await harness.waitForRuns(1);

		await harness.report(task.id, "milestone", "first");
		await harness.report(task.id, "milestone", "second");

		await vi.waitFor(() =>
			expect(harness.logs).toContainEqual({
				level: "error",
				event: "task.delivery_failed",
				context: { taskId: task.id },
				details: { error: expect.any(Error), reportSeq: 2 },
			}),
		);
		expect(harness.logs).toContainEqual({
			level: "warn",
			event: "task.delivery_rejected",
			context: { taskId: task.id },
			details: { reportSeq: 1 },
		});
		expect(harness.latest(task.id).reports.map((item) => item.deliveredAt)).toEqual([null, null]);
	});

	it("停止後の報告は配送せず、次回起動時の再配送に残す", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("late report"));
		await harness.waitForRuns(1);

		harness.service.stopIntake();
		await expect(harness.report(task.id, "milestone", "late")).resolves.toMatchObject({ seq: 1 });

		expect(harness.delivered).toEqual([]);
		expect(harness.latest(task.id).reports[0]?.deliveredAt).toBeNull();
	});

	it("DM起点のtaskは他の会話から見えず操作できないが、eventからは見える", async () => {
		const harness = await createHarness({
			isPrivateSession: (session) => session.key.startsWith("discord:dm:"),
			maxConcurrent: 0,
		});
		const privateTask = await harness.service.create(dmOrigin, input("private"));
		const shared = await harness.service.create(channelOrigin, input("shared"));
		const heartbeatTask = await harness.service.create(heartbeatOrigin, input("heartbeat"));

		const channelView = harness.service
			.listFor({ kind: "conversation", sessionKey: channelOrigin.session.key })
			.map((summary) => summary["id"]);
		expect(channelView).toEqual([shared.id]);
		const dmView = harness.service
			.listFor({ kind: "conversation", sessionKey: dmOrigin.session.key })
			.map((summary) => summary["id"]);
		expect(dmView).toHaveLength(2);
		expect(dmView).toEqual(expect.arrayContaining([privateTask.id, shared.id]));
		expect(harness.service.listFor({ kind: "event" }).map((summary) => summary["id"])).toEqual(
			expect.arrayContaining([privateTask.id, shared.id, heartbeatTask.id]),
		);
		await expect(harness.service.cancel(channelOrigin, privateTask.id, null)).rejects.toThrow(
			"not available here",
		);
		await expect(harness.service.message(channelOrigin, heartbeatTask.id, "x")).rejects.toThrow(
			"not available here",
		);
		await expect(harness.service.cancel(heartbeatOrigin, privateTask.id, null)).resolves.toBe(
			"cancelled",
		);
	});

	it("終了から24時間を過ぎたtaskを一覧とボードから外す", async () => {
		const harness = await createHarness({
			tasks: [
				storedTask({ id: "old", status: "completed", updatedAt: "2026-10-17T23:59:59.000Z" }),
				storedTask({ id: "recent", status: "failed", updatedAt: "2026-10-18T12:00:00.000Z" }),
			],
		});

		expect(harness.service.listFor({ kind: "event" }).map((summary) => summary["id"])).toEqual([
			"recent",
		]);
		expect(harness.service.snapshot().tasks.map((task) => task.id)).toEqual(["recent"]);
	});

	it("worker以外からの報告、実行していないtaskへの報告、workerからのtask作成を拒否する", async () => {
		const harness = await createHarness({
			tasks: [storedTask({ id: "done", status: "completed" })],
		});

		await expect(
			harness.service.report(channelOrigin, { kind: "result", summary: "x", artifacts: [] }),
		).rejects.toThrow("Only a task worker can report");
		await expect(harness.report("done", "result", "again")).rejects.toThrow("is not running");
		await expect(
			harness.service.create({ kind: "task", taskId: "done" }, input("nested")),
		).rejects.toThrow("cannot create a task");
	});

	it("保存の失敗を記録し、taskの処理は続ける", async () => {
		const harness = await createHarness();
		harness.save.mockRejectedValue(new Error("disk full"));

		const task = await harness.service.create(channelOrigin, input("unsaved"));
		await harness.waitForRuns(1);

		expect(harness.logs).toContainEqual({
			level: "error",
			event: "task.save_failed",
			context: { taskId: task.id },
			details: { error: expect.any(Error) },
		});
		expect(harness.service.snapshot().tasks[0]).toMatchObject({ id: task.id, status: "running" });
	});
});

type RecordedRun = { sessionId: string; messages: readonly AgentInputMessage[] };
type FakeSession = {
	readonly id: string;
	run: Mock<AgentSession["run"]>;
	steer: Mock<AgentSession["steer"]>;
	abort: Mock<AgentSession["abort"]>;
	setModel: Mock<AgentSession["setModel"]>;
	close: Mock<AgentSession["close"]>;
	status: Mock<AgentSession["status"]>;
};

async function createHarness(
	options: {
		isPrivateSession?: (
			session: Extract<TaskOrigin, { kind: "conversation" }>["session"],
		) => boolean;
		maxConcurrent?: number;
		tasks?: Task[];
	} = {},
) {
	const calls: string[] = [];
	const runs: RecordedRun[] = [];
	const settlers: Array<{ resolve(result: AgentRunResult): void; reject(error: unknown): void }> =
		[];
	const sessions: FakeSession[] = [];
	let idCount = 0;

	function createSession(_origin: ToolOrigin): { ownerId: string; session: FakeSession } {
		const index = sessions.length + 1;
		const id = `session-${String(index)}`;
		const session: FakeSession = {
			id,
			// 実行の終わり際の割り込みを再現できるよう、async関数で包まず生のPromiseを返す。
			run: vi.fn<AgentSession["run"]>((messages) => {
				runs.push({ sessionId: id, messages });
				return new Promise<AgentRunResult>((resolve, reject) => {
					settlers.push({ resolve, reject });
				});
			}),
			steer: vi.fn<AgentSession["steer"]>(),
			abort: vi.fn<AgentSession["abort"]>(async () => {
				const runIndex = runs.findLastIndex((run) => run.sessionId === id);
				settlers[runIndex]?.resolve({ status: "aborted" });
			}),
			setModel: vi.fn<AgentSession["setModel"]>(),
			close: vi.fn<AgentSession["close"]>(async () => {
				calls.push(`close:${id}`);
			}),
			status: vi.fn<AgentSession["status"]>(),
		};
		sessions.push(session);
		return { ownerId: `owner-${String(index)}`, session };
	}

	const openSession = vi.fn<OpenAgentSession>(async (origin) => createSession(origin));
	const releaseTools = vi.fn(async (ownerId: string) => {
		calls.push(`release:${ownerId}`);
	});
	const delivered: Array<{ origin: TaskOrigin; event: LunaEvent }> = [];
	const deliver = vi.fn<TaskDeliveryPort["deliver"]>(async () => "accepted");
	const saved = new Map<string, Task>();
	const save = vi.fn(async (task: Task) => {
		saved.set(task.id, task);
	});
	const logger = createRecordingLogger();
	const service = new TaskService({
		createId: () => `id-${String(++idCount)}`,
		delivery: {
			deliver: async (origin, event) => {
				delivered.push({ origin, event });
				return await deliver(origin, event);
			},
		},
		isPrivateSession: options.isPrivateSession ?? (() => false),
		logger,
		maxConcurrent: options.maxConcurrent ?? 2,
		now: () => new Date("2026-10-19T00:00:00.000Z"),
		openSession,
		releaseTools,
		store: { loadAll: async () => options.tasks ?? [], save },
	});
	await service.start();

	return {
		calls,
		createSession,
		deliver,
		delivered,
		failRun: (index: number, error: Error): void => {
			const settler = settlers[index];
			if (settler === undefined) throw new Error(`run ${String(index)} is missing`);
			settler.reject(error);
		},
		finishRun: (index: number, result: AgentRunResult = COMPLETED): void => {
			const settler = settlers[index];
			if (settler === undefined) throw new Error(`run ${String(index)} is missing`);
			settler.resolve(result);
		},
		latest: (taskId: string): Task => {
			const task = saved.get(taskId);
			if (task === undefined) throw new Error(`task ${taskId} was not saved`);
			return task;
		},
		logs: logger.entries,
		openSession,
		releaseTools,
		report: async (
			taskId: string,
			kind: TaskReportKind,
			summary: string,
			artifacts: string[] = [],
		) => await service.report({ kind: "task", taskId }, { kind, summary, artifacts }),
		runs,
		save,
		service,
		sessions,
		waitForRuns: async (count: number) => {
			await vi.waitFor(() => expect(runs).toHaveLength(count));
		},
	};
}

function taskIdOf(messages: readonly AgentInputMessage[] | undefined): unknown {
	const text = messages?.[0]?.text;
	if (text === undefined) return undefined;
	const value: unknown = JSON.parse(text);
	return typeof value === "object" && value != null && "id" in value ? value.id : undefined;
}

function input(title: string): { title: string; instructions: string } {
	return { title, instructions: `${title}の指示` };
}

function report(
	seq: number,
	kind: TaskReportKind,
	summary: string,
	deliveredAt: string | null,
): Task["reports"][number] {
	return {
		seq,
		kind,
		summary,
		artifacts: [],
		reportedAt: "2026-10-18T21:00:00.000Z",
		deliveredAt,
	};
}

function storedTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
	return {
		version: 1,
		title: overrides.id,
		instructions: "stored",
		origin: channelOrigin,
		private: false,
		status: "queued",
		attempts: 0,
		createdAt: "2026-10-18T00:00:00.000Z",
		updatedAt: "2026-10-18T00:00:00.000Z",
		reports: [],
		messages: [],
		outcome: null,
		...overrides,
	};
}

function createDeferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}
