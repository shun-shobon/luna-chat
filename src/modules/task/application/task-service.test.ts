import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { JsonValue } from "../../../shared/json";
import type {
	AgentRuntimePort,
	AgentTurnResult,
} from "../../agent/ports/outbound/agent-runtime-port";
import type { EffectOrigin, EffectRequest, EffectResult } from "../../effect/domain/effect";
import type { EffectBatchPort } from "../../effect/ports/effect-batch-port";
import type { EffectOutputContract } from "../../effect/ports/effect-output-contract";
import type { LunaEvent } from "../../event/domain/luna-event";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type { Task, TaskOrigin } from "../domain/task";
import type { TaskDeliveryOutcome } from "../ports/task-delivery-port";
import { TaskService } from "./task-service";

const channelOrigin = {
	kind: "conversation",
	session: {
		key: "discord:guild_channel:1:2",
		source: "discord/main",
		context: { kind: "guild_channel", guildId: "1", channelId: "2" },
	},
} as const satisfies EffectOrigin;
const dmOrigin = {
	kind: "conversation",
	session: {
		key: "discord:dm:3:4",
		source: "discord/main",
		context: { kind: "dm", channelId: "3", userId: "4" },
	},
} as const satisfies EffectOrigin;
const heartbeatOrigin = {
	kind: "event",
	eventId: "event-1",
	eventType: "system.heartbeat.fired.v1",
} as const satisfies EffectOrigin;

type ScriptedTurn = {
	completion: Deferred<AgentTurnResult>;
	input: Record<string, unknown>;
	threadId: string;
	turnId: string;
};

describe("TaskService", () => {
	it("作成したtaskを専用threadで実行し、resultを起点へ配送してthreadを閉じる", async () => {
		const harness = await createHarness();

		const task = await harness.service.create(channelOrigin, {
			title: "調査",
			instructions: "Codexの変更点を調べる",
		});
		expect(task.status).toBe("queued");
		await harness.waitForTurns(1);

		expect(harness.turns[0]?.input).toMatchObject({
			source: "task",
			task: {
				id: task.id,
				title: "調査",
				instructions: "Codexの変更点を調べる",
				origin: channelOrigin.session.key,
				attempt: 1,
				previous_reports: [],
			},
			messages: [],
		});
		await harness.complete(0, [report("result", "まとめた", ["/workspace/report.md"])]);

		await vi.waitFor(() => expect(harness.agent.archiveThread).toHaveBeenCalledWith("thread-1"));
		expect(harness.latest(task.id)).toMatchObject({ status: "completed", attempts: 1 });
		expect(harness.delivered).toHaveLength(1);
		expect(harness.delivered[0]?.origin).toEqual(channelOrigin);
		expect(harness.delivered[0]?.event).toMatchObject({
			type: "luna.task.reported.v1",
			source: "luna/task",
			subject: task.id,
			data: {
				task: { id: task.id, status: "completed" },
				report: { kind: "result", summary: "まとめた", artifacts: ["/workspace/report.md"] },
			},
		});
		await vi.waitFor(() => expect(harness.latest(task.id).reports[0]?.deliveredAt).not.toBeNull());
	});

	it("同時実行数を超えるtaskは先行taskの終了までqueueに残す", async () => {
		const harness = await createHarness({ maxConcurrent: 1 });
		const first = await harness.service.create(channelOrigin, input("first"));
		const second = await harness.service.create(channelOrigin, input("second"));
		await harness.waitForTurns(1);

		expect(harness.latest(second.id).status).toBe("queued");
		await harness.complete(0, [report("result", "done")]);
		await harness.waitForTurns(2);

		expect(harness.latest(first.id).status).toBe("completed");
		expect(harness.turns[1]?.input).toMatchObject({ task: { id: second.id } });
	});

	it("progressは配送せず、milestoneは配送して作業を続ける", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("long"));
		await harness.waitForTurns(1);

		await harness.complete(0, [report("progress", "半分"), report("milestone", "重要な発見")]);
		await harness.waitForTurns(2);

		expect(harness.turns[1]?.input).toEqual({ source: "task_check", task_id: task.id });
		expect(harness.delivered.map((delivery) => delivery.event.data)).toEqual([
			expect.objectContaining({ report: expect.objectContaining({ kind: "milestone" }) }),
		]);
		expect(harness.service.listFor({ kind: "event" })[0]).toMatchObject({
			id: task.id,
			status: "running",
			latest_report: { kind: "milestone", summary: "重要な発見" },
		});
	});

	it("questionで待機したthreadを保持し、返答を同じthreadのtask_messagesとして渡す", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("ask"));
		await harness.waitForTurns(1);
		await harness.complete(0, [report("question", "どちらにする？")]);
		await vi.waitFor(() => expect(harness.latest(task.id).status).toBe("waiting_input"));
		expect(harness.agent.archiveThread).not.toHaveBeenCalled();

		await harness.service.message(channelOrigin, task.id, "Aで");
		await harness.waitForTurns(2);

		expect(harness.turns[1]?.threadId).toBe("thread-1");
		expect(harness.turns[1]?.input).toMatchObject({
			source: "task_messages",
			task_id: task.id,
			messages: [{ text: "Aで" }],
		});
		expect(harness.latest(task.id)).toMatchObject({ status: "running", attempts: 1 });
	});

	it("実行中のmessageをsteerし、失敗したmessageはchain終了後の次turnで渡す", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("steer"));
		await harness.waitForTurns(1);
		harness.agent.steerTurn.mockRejectedValueOnce(new Error("final answer emitted"));

		await harness.service.message(channelOrigin, task.id, "方針変更");
		await vi.waitFor(() => expect(harness.agent.steerTurn).toHaveBeenCalledOnce());
		expect(JSON.parse(harness.agent.steerTurn.mock.calls[0]?.[2] ?? "")).toMatchObject({
			source: "task_messages",
			messages: [{ text: "方針変更" }],
		});
		await harness.complete(0, [report("progress", "途中")]);
		await harness.waitForTurns(2);

		expect(harness.turns[1]?.input).toMatchObject({
			source: "task_messages",
			messages: [{ text: "方針変更" }],
		});
	});

	it("最終報告なしでchainを終えたら一度だけ確認し、それでもなければ失敗を配送する", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("silent"));
		await harness.waitForTurns(1);
		await harness.complete(0, []);
		await harness.waitForTurns(2);
		await harness.complete(1, []);

		await vi.waitFor(() => expect(harness.latest(task.id).status).toBe("failed"));
		expect(harness.latest(task.id).outcome).toBe(
			"Worker ended without a result, question, or failure report.",
		);
		expect(harness.delivered[0]?.event.data).toMatchObject({ report: { kind: "failure" } });
	});

	it("不正な最終出力は理由を返して再試行させ、連続する不正では失敗させる", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("format"));
		await harness.waitForTurns(1);
		harness.completeRaw(0, "not json");
		await harness.waitForTurns(2);

		expect(harness.turns[1]?.input).toMatchObject({ source: "output_error", task_id: task.id });
		harness.completeRaw(1, "still not json");
		await harness.waitForTurns(3);
		harness.completeRaw(2, "never json");

		await vi.waitFor(() => expect(harness.latest(task.id).status).toBe("failed"));
	});

	it("turnの失敗はtaskを失敗させて理由を配送する", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("fail"));
		await harness.waitForTurns(1);

		harness.turns[0]?.completion.resolve({ status: "failed", errorMessage: "model error" });

		await vi.waitFor(() => expect(harness.latest(task.id).status).toBe("failed"));
		expect(harness.latest(task.id).outcome).toBe("model error");
		expect(harness.delivered[0]?.event.data).toMatchObject({
			report: { kind: "failure", summary: "model error" },
		});
	});

	it("接続断で中断したtaskを新threadで再開し、過去の報告をbriefへ含める", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("resume"));
		await harness.waitForTurns(1);
		await harness.complete(0, [report("milestone", "前半完了")]);
		await harness.waitForTurns(2);

		harness.service.connectionLost();
		harness.turns[1]?.completion.reject(new Error("connection lost"));
		await harness.waitForTurns(3);

		expect(harness.turns[2]?.threadId).toBe("thread-2");
		expect(harness.turns[2]?.input).toMatchObject({
			source: "task",
			task: {
				id: task.id,
				attempt: 2,
				previous_reports: [{ seq: 1, kind: "milestone", summary: "前半完了" }],
			},
		});
	});

	it("実行中taskの取消でturnを中断し、以後のturnを始めない", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("cancel"));
		await harness.waitForTurns(1);

		await expect(harness.service.cancel(channelOrigin, task.id, "不要")).resolves.toBe("cancelled");
		expect(harness.agent.interruptTurn).toHaveBeenCalledWith("thread-1", "turn-1");
		harness.turns[0]?.completion.resolve({ status: "interrupted" });

		await vi.waitFor(() => expect(harness.agent.archiveThread).toHaveBeenCalledWith("thread-1"));
		expect(harness.turns).toHaveLength(1);
		expect(harness.latest(task.id)).toMatchObject({ status: "cancelled", outcome: "不要" });
		await expect(harness.service.message(channelOrigin, task.id, "やっぱり")).rejects.toThrow(
			"already cancelled",
		);
	});

	it("DM起点のtaskは他の会話から見えず操作できないが、eventからは見える", async () => {
		const harness = await createHarness({
			isPrivateSession: (session) => session.key.startsWith("discord:dm:"),
		});
		const task = await harness.service.create(dmOrigin, input("private"));
		const shared = await harness.service.create(channelOrigin, input("shared"));
		const heartbeatTask = await harness.service.create(heartbeatOrigin, input("heartbeat"));

		const channelView = harness.service
			.listFor({ kind: "conversation", sessionKey: channelOrigin.session.key })
			.map((summary) => summary["id"]);
		expect(channelView).toEqual(expect.arrayContaining([shared.id]));
		expect(channelView).not.toContain(task.id);
		expect(channelView).not.toContain(heartbeatTask.id);
		expect(
			harness.service
				.listFor({ kind: "conversation", sessionKey: dmOrigin.session.key })
				.map((summary) => summary["id"]),
		).toEqual(expect.arrayContaining([task.id, shared.id]));
		expect(harness.service.listFor({ kind: "event" })).toHaveLength(3);
		await expect(harness.service.cancel(channelOrigin, task.id, null)).rejects.toThrow(
			"not available here",
		);
	});

	it("終了から24時間を過ぎたtaskは一覧から外す", async () => {
		const harness = await createHarness({
			tasks: [
				storedTask({ id: "old", status: "completed", updatedAt: "2026-10-17T23:59:59.000Z" }),
				storedTask({ id: "recent", status: "failed", updatedAt: "2026-10-18T12:00:00.000Z" }),
			],
		});

		expect(harness.service.listFor({ kind: "event" }).map((summary) => summary["id"])).toEqual([
			"recent",
		]);
	});

	it("起動時に実行中だったtaskを再開し、未配送の通知を配送し直す", async () => {
		const harness = await createHarness({
			tasks: [
				storedTask({ id: "interrupted", status: "running", attempts: 1 }),
				storedTask({
					id: "answered",
					status: "completed",
					reports: [
						{
							seq: 1,
							kind: "result",
							summary: "done",
							artifacts: [],
							reportedAt: "2026-10-18T23:00:00.000Z",
							deliveredAt: null,
						},
					],
				}),
			],
		});

		await harness.waitForTurns(1);
		expect(harness.turns[0]?.input).toMatchObject({ task: { id: "interrupted", attempt: 2 } });
		expect(harness.delivered.map((delivery) => delivery.event.subject)).toEqual(["answered"]);
	});

	it("停止時に実行中taskをqueueへ戻してturnを中断し、threadを閉じてから終える", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("shutdown"));
		await harness.waitForTurns(1);

		const draining = harness.service.drain();
		expect(harness.agent.interruptTurn).toHaveBeenCalledWith("thread-1", "turn-1");
		harness.turns[0]?.completion.resolve({ status: "interrupted" });
		await draining;

		expect(harness.saved.get(task.id)?.status).toBe("queued");
		expect(harness.agent.archiveThread).toHaveBeenCalledWith("thread-1");
		expect(harness.turns).toHaveLength(1);
		await expect(harness.service.create(channelOrigin, input("late"))).rejects.toThrow(
			"intake is stopped",
		);
	});

	it("終了報告の後はEffect失敗があってもfollow-upせず、接続断でも再実行しない", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("done twice"));
		await harness.waitForTurns(1);

		await harness.complete(0, [report("result", "done"), report("result", "again")]);
		await vi.waitFor(() => expect(harness.agent.archiveThread).toHaveBeenCalledWith("thread-1"));
		harness.service.connectionLost();
		await flush();

		expect(harness.turns).toHaveLength(1);
		expect(harness.latest(task.id).status).toBe("completed");
	});

	it("question保存中に接続が切れたら旧threadを保持せず、返答は新threadのbriefで渡す", async () => {
		const harness = await createHarness();
		const task = await harness.service.create(channelOrigin, input("ask"));
		await harness.waitForTurns(1);

		const gate = harness.blockSaves();
		await harness.complete(0, [report("question", "どちら？")]);
		harness.service.connectionLost();
		gate.resolve(undefined);
		await vi.waitFor(() => expect(harness.latest(task.id).status).toBe("waiting_input"));
		await flush();
		await harness.service.message(channelOrigin, task.id, "Bで");
		await harness.waitForTurns(2);

		expect(harness.turns[1]?.threadId).toBe("thread-2");
		expect(harness.turns[1]?.input).toMatchObject({
			source: "task",
			messages: [{ text: "Bで" }],
		});
	});

	it("取消で実行中のsystem.waitを打ち切り、実行枠を空ける", async () => {
		const harness = await createHarness({ maxConcurrent: 1 });
		const waiting = await harness.service.create(channelOrigin, input("wait"));
		const next = await harness.service.create(channelOrigin, input("next"));
		await harness.waitForTurns(1);
		harness.completeRaw(0, JSON.stringify({ effects: [] }));
		await harness.waitForTurns(2);
		harness.effectsGate.block();
		harness.completeRaw(1, JSON.stringify({ effects: [] }));
		await vi.waitFor(() => expect(harness.effectsGate.blocked).toBe(true));

		await harness.service.cancel(channelOrigin, waiting.id, null);

		expect(harness.effectsGate.released).toContain("owner-1");
		await harness.waitForTurns(3);
		expect(harness.turns[2]?.input).toMatchObject({ task: { id: next.id } });
	});

	it("配送を拒否された通知は未配送のまま残す", async () => {
		const harness = await createHarness({ deliveryOutcome: "rejected" });
		const task = await harness.service.create(channelOrigin, input("reject"));
		await harness.waitForTurns(1);
		await harness.complete(0, [report("result", "done")]);

		await vi.waitFor(() => expect(harness.delivered).toHaveLength(1));
		await flush();
		expect(harness.latest(task.id).reports[0]?.deliveredAt).toBeNull();
		expect(harness.log).toHaveBeenCalledWith(
			"warn",
			"task.delivery_rejected",
			{ taskId: task.id },
			{ reportSeq: 1 },
		);
	});

	it("worker以外からの報告とworkerからのtask作成を拒否する", async () => {
		const harness = await createHarness();

		await expect(
			harness.service.report(channelOrigin, { kind: "result", summary: "x", artifacts: [] }),
		).rejects.toThrow("Only a task worker can report");
		await expect(
			harness.service.create({ kind: "task", taskId: "task-1" }, input("nested")),
		).rejects.toThrow("cannot create a task");
	});
});

async function createHarness(
	options: {
		deliveryOutcome?: TaskDeliveryOutcome;
		isPrivateSession?: (
			session: Extract<TaskOrigin, { kind: "conversation" }>["session"],
		) => boolean;
		maxConcurrent?: number;
		tasks?: Task[];
	} = {},
) {
	const turns: ScriptedTurn[] = [];
	let threadCount = 0;
	let idCount = 0;
	let ownerCount = 0;
	const agent = {
		archiveThread: vi.fn<AgentRuntimePort["archiveThread"]>(async () => undefined),
		deleteThread: vi.fn<AgentRuntimePort["deleteThread"]>(async () => undefined),
		interruptTurn: vi.fn<AgentRuntimePort["interruptTurn"]>(async () => undefined),
		listArchivedThreads: vi.fn<AgentRuntimePort["listArchivedThreads"]>(async () => ({
			data: [],
		})),
		listModels: vi.fn<AgentRuntimePort["listModels"]>(async () => []),
		openThread: vi.fn<AgentRuntimePort["openThread"]>(
			async () => `thread-${String(++threadCount)}`,
		),
		startTurn: vi.fn<AgentRuntimePort["startTurn"]>(async (threadId, request) => {
			const completion = deferred<AgentTurnResult>();
			const turnId = `turn-${String(turns.length + 1)}`;
			turns.push({ completion, input: parseObject(request.input), threadId, turnId });
			return { completion: completion.promise, turnId };
		}),
		steerTurn: vi.fn<AgentRuntimePort["steerTurn"]>(async () => undefined),
	};
	const delivered: Array<{ origin: TaskOrigin; event: LunaEvent }> = [];
	const saved = new Map<string, Task>();
	const log = vi.fn<LoggerPort["log"]>();
	const effectsGate = createEffectsGate();
	let saveGate: Deferred<undefined> | undefined;
	let service: TaskService | undefined;
	const requireService = (): TaskService => {
		if (service === undefined) throw new Error("service is not ready");
		return service;
	};
	service = new TaskService({
		agent,
		createId: () => `id-${String(++idCount)}`,
		createThreadInput: async () => ({
			baseInstructions: "Luna",
			config: {},
			cwd: "/workspace",
			developerInstructions: "worker",
			executionOwnerId: `owner-${String(++ownerCount)}`,
		}),
		delivery: {
			deliver: async (origin, event) => {
				delivered.push({ origin, event });
				return options.deliveryOutcome ?? "accepted";
			},
		},
		effectOutput: createReportOutputContract(requireService),
		effects: effectsGate.batch,
		isPrivateSession: options.isPrivateSession ?? (() => false),
		logger: { log },
		maxConcurrent: options.maxConcurrent ?? 2,
		now: () => new Date("2026-10-19T00:00:00.000Z"),
		store: {
			loadAll: async () => options.tasks ?? [],
			save: async (task) => {
				await saveGate?.promise;
				saved.set(task.id, task);
			},
		},
	});
	await service.start();
	const completeRaw = (index: number, outputText: string): void => {
		const turn = turns[index];
		if (turn === undefined) throw new Error(`turn ${String(index)} is missing`);
		turn.completion.resolve({ status: "completed", outputText });
	};
	return {
		agent,
		complete: async (index: number, effects: JsonValue[]) => {
			completeRaw(index, JSON.stringify({ effects }));
			await flush();
		},
		blockSaves: (): Deferred<undefined> => {
			saveGate = deferred<undefined>();
			return saveGate;
		},
		completeRaw,
		delivered,
		effectsGate,
		latest: (taskId: string): Task => {
			const task = saved.get(taskId);
			if (task === undefined) throw new Error(`task ${taskId} was not saved`);
			return task;
		},
		log,
		saved,
		service,
		turns,
		waitForTurns: async (count: number) => {
			await vi.waitFor(() => expect(turns).toHaveLength(count));
		},
	};
}

const outputSchema = z.strictObject({
	effects: z.array(
		z.strictObject({
			type: z.literal("task.report"),
			input: z.strictObject({
				kind: z.enum(["progress", "milestone", "question", "result", "failure"]),
				summary: z.string(),
				artifacts: z.array(z.string()).nullable(),
			}),
		}),
	),
});

function createReportOutputContract(service: () => TaskService): EffectOutputContract {
	return {
		jsonSchema: {},
		parse: (text) => ({
			effects: outputSchema.parse(JSON.parse(text)).effects.map((effect): EffectRequest => ({
				type: effect.type,
				input: effect.input,
				target: null,
				run: async (execution) =>
					await service().report(execution.origin, {
						kind: effect.input.kind,
						summary: effect.input.summary,
						artifacts: effect.input.artifacts ?? [],
					}),
			})),
		}),
	};
}

function createEffectsGate() {
	let pending: Deferred<undefined> | undefined;
	const gate = {
		blocked: false,
		released: [] as string[],
		block: () => {
			pending = deferred<undefined>();
		},
		batch: {
			execute: async (...args: Parameters<EffectBatchPort["execute"]>) => {
				if (pending !== undefined) {
					gate.blocked = true;
					await pending.promise;
				}
				return await fakeEffectBatch.execute(...args);
			},
			release: async (ownerId: string) => {
				gate.released.push(ownerId);
				pending?.resolve(undefined);
				pending = undefined;
			},
		} satisfies EffectBatchPort,
	};
	return gate;
}

const fakeEffectBatch: EffectBatchPort = {
	execute: async (effects, execution) =>
		await Promise.all(
			effects.map(async (effect, index): Promise<EffectResult> => {
				try {
					return {
						index,
						type: effect.type,
						target: null,
						success: true,
						value: await effect.run(execution),
					};
				} catch (error: unknown) {
					return { index, type: effect.type, target: null, success: false, error: String(error) };
				}
			}),
		),
	release: async () => {},
};

function input(title: string): { title: string; instructions: string } {
	return { title, instructions: `${title}の指示` };
}

function report(kind: string, summary: string, artifacts: string[] | null = null): JsonValue {
	return { type: "task.report", input: { kind, summary, artifacts } };
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

function parseObject(text: string): Record<string, unknown> {
	const value: unknown = JSON.parse(text);
	if (typeof value !== "object" || value == null || Array.isArray(value)) {
		throw new Error("turn input must be an object");
	}
	return Object.fromEntries(Object.entries(value));
}

type Deferred<T> = {
	promise: Promise<T>;
	reject(error: unknown): void;
	resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

async function flush(): Promise<void> {
	for (let index = 0; index < 10; index += 1) await Promise.resolve();
}
