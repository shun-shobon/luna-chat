import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ActivityNotice } from "../../agent/ports/outbound/agent-session-port";
import { createRecordingLogger } from "../../observability/testing/recording-logger";
import type { ToolActivities, ToolExecution, ToolOrigin } from "../../tool/domain/tool";
import type { MinecraftAction } from "../domain/action";
import type { WorldSnapshot } from "../domain/world";
import { EMPTY_WORLD_MEMORY } from "../domain/world-memory";
import type { WorldMemory } from "../domain/world-memory";
import type { Decision } from "../ports/decision-model-port";
import type {
	ActionOutcome,
	ConnectionListener,
	CustomActionsReport,
	MinecraftConnection,
} from "../ports/minecraft-connection-port";
import { snapshotWith } from "../testing/world-fixtures";
import { MinecraftPlayService } from "./minecraft-play-service";

const TASK_ORIGIN: ToolOrigin = { kind: "task", taskId: "task-1", worker: "minecraft" };
const LOG = { name: "oak_log", position: { x: 2, y: 64, z: 0 }, distance: 2, harvestable: true };
const PLANNER_INTERVAL_MS = 60_000;
const EventTypeSchema = z.looseObject({ type: z.string() });

describe("MinecraftPlayService", () => {
	it("最初のツール呼び出しで接続して作業を始め、ほかの実行やタスク以外からの呼び出しは断る", async () => {
		const harness = createHarness();

		const observation = await harness.service.observe(harness.execution);

		expect(harness.connect).toHaveBeenCalledOnce();
		expect(harness.activities.count()).toBe(1);
		expect(observation).toMatchObject({ goal: null, goal_status: null, recent_events: [] });
		await expect(
			harness.service.observe({ ...harness.execution, ownerId: "other-owner" }),
		).rejects.toThrow("Minecraft is being played by task task-1");
		await expect(
			harness.service.observe({
				...harness.execution,
				origin: { kind: "event", eventId: "e", eventType: "t" },
			}),
		).rejects.toThrow("only for the minecraft worker");
		await harness.stop();
	});

	it("同じ応答で並行に呼ばれたツールでも、接続は1つだけにする", async () => {
		const harness = createHarness();

		await Promise.all([harness.service.observe(harness.execution), harness.setGoal()]);

		expect(harness.connect).toHaveBeenCalledOnce();
		expect(harness.activities.count()).toBe(1);
		await harness.stop();
	});

	it("切断に失敗してもプレイを外し、次の呼び出しで接続し直す", async () => {
		const harness = createHarness();
		await harness.service.observe(harness.execution);
		harness.close.mockRejectedValueOnce(new Error("worker did not answer"));

		await harness.activities.stopAll();

		expect(harness.service.snapshot().connection).toBe("idle");
		await harness.service.observe({ ...harness.execution, ownerId: "owner-2" });
		expect(harness.connect).toHaveBeenCalledTimes(2);
		await harness.stop();
	});

	it("目標を置くと、観測から候補を作って決定モデルに選ばせ、選ばれた行動を実行する", async () => {
		const harness = createHarness();
		harness.snapshot = snapshotWith({ visibleBlocks: [LOG] });
		harness.decide.mockImplementation(async (input) =>
			decision(
				input.candidates.findIndex((text) => text.startsWith("Mine the oak_log")),
				"in_progress",
			),
		);

		await harness.service.setGoal(harness.execution, {
			objective: "Collect 4 oak logs",
			targets: { oak_log: 4 },
			waypoint: null,
		});

		await vi.waitFor(() => expect(harness.executed.length).toBeGreaterThan(0));
		expect(harness.executed[0]).toEqual({ type: "mine", block: "oak_log", position: LOG.position });
		const [input] = harness.decide.mock.calls[0] ?? [];
		expect(input?.state).toMatchObject({
			goal: { objective: "Collect 4 oak logs", targets: { oak_log: 4 }, waypoint: null },
		});
		expect(harness.service.snapshot()).toMatchObject({
			taskId: "task-1",
			connection: "connected",
			goalStatus: { status: "in_progress", probability: 0.9 },
		});
		await harness.stop();
	});

	it("ルナが足した行動を候補に入れて実行し、観測のツールでその状態を返す", async () => {
		const harness = createHarness();
		harness.setCustomActions({
			loaded: ["build_wall", "broken"],
			candidates: [
				{ name: "build_wall", description: "Build a wall", args: { length: 3 }, timeoutMs: 60_000 },
			],
			errors: [{ name: "broken", error: "candidates failed: boom" }],
		});
		harness.decide.mockImplementation(async (input) =>
			decision(input.candidates.indexOf("Build a wall"), "in_progress"),
		);

		await harness.setGoal();
		await vi.waitFor(() => expect(harness.executed.length).toBeGreaterThan(0));
		const observation = await harness.service.observe(harness.execution);

		expect(harness.executed[0]).toEqual({
			type: "custom",
			name: "build_wall",
			args: { length: 3 },
			timeoutMs: 60_000,
		});
		expect(observation["custom_actions"]).toEqual({
			loaded: ["build_wall", "broken"],
			candidates: ["Build a wall"],
			errors: [{ name: "broken", error: "candidates failed: boom" }],
		});
		await harness.stop();
	});

	it("達成の答えが2回続いたら goal_done を知らせて判断を止め、新しい目標で再開する", async () => {
		const harness = createHarness();
		harness.decide.mockResolvedValue(decision(0, "done"));

		await harness.setGoal();
		await vi.waitFor(() => expect(harness.eventTypes()).toContain("goal_done"));
		const calls = harness.decide.mock.calls.length;
		await flush();

		expect(calls).toBe(2);
		expect(harness.decide).toHaveBeenCalledTimes(2);
		expect(harness.executed).toHaveLength(1);
		expect(harness.notices.at(-1)).toMatchObject({ urgent: false, replaceKey: "goal_done" });
		expect(JSON.parse(harness.notices.at(-1)?.message.text ?? "")).toMatchObject({
			type: "goal_done",
			urgent: false,
			observation: { goal: { objective: "Collect 4 oak logs" } },
		});

		harness.decide.mockResolvedValue(decision(0, "in_progress"));
		await harness.setGoal();
		await vi.waitFor(() => expect(harness.decide.mock.calls.length).toBeGreaterThan(2));
		await harness.stop();
	});

	it("持ち物が targets を満たしたら、決定モデルに尋ねずに goal_done を知らせる", async () => {
		const harness = createHarness();
		harness.snapshot = snapshotWith({ inventory: { oak_log: 4 } });

		await harness.setGoal();

		await vi.waitFor(() => expect(harness.eventTypes()).toEqual(["goal_done"]));
		expect(JSON.parse(harness.notices[0]?.message.text ?? "")).toMatchObject({
			detail: "The inventory has every target: 4 oak_log.",
		});
		expect(harness.decide).not.toHaveBeenCalled();
		await harness.stop();
	});

	it("決定モデルの失敗が3回続いたら goal_stuck を知らせる", async () => {
		const harness = createHarness();
		harness.decide.mockRejectedValue(new Error("timeout"));

		await harness.setGoal();

		await vi.waitFor(() => expect(harness.eventTypes()).toEqual(["goal_stuck"]));
		expect(harness.decide).toHaveBeenCalledTimes(3);
		expect(harness.executed).toEqual([]);
		await harness.stop();
	});

	it("推論の間に体力が減ったら答えを捨て、行動しない", async () => {
		const harness = createHarness();
		let observed = 0;
		harness.observe.mockImplementation(async () => {
			observed += 1;
			// 推論の後の観測（偶数回目）でだけ体力が減っている。
			return snapshotWith({ self: { health: observed % 2 === 0 ? 15 : 20 } });
		});
		harness.decide.mockResolvedValue(decision(0, "in_progress"));

		await harness.setGoal();

		await vi.waitFor(() => expect(harness.decide.mock.calls.length).toBeGreaterThanOrEqual(3));
		expect(harness.executed).toEqual([]);
		await harness.stop();
	});

	it("存在しないアイテムと、覚えていない場所の名前の目標は断る", async () => {
		const harness = createHarness();
		harness.unknownItems.mockResolvedValue(["copper_sword"]);

		await expect(
			harness.service.setGoal(harness.execution, {
				objective: "Craft",
				targets: { copper_sword: 1 },
				waypoint: null,
			}),
		).rejects.toThrow("Unknown item names: copper_sword");
		harness.unknownItems.mockResolvedValue([]);
		await expect(
			harness.service.setGoal(harness.execution, {
				objective: "Go home",
				targets: {},
				waypoint: "base",
			}),
		).rejects.toThrow("Unknown place name: base");
		await harness.stop();
	});

	it("名付けた場所を記憶して保存し、目標の waypoint に名前で使える", async () => {
		const harness = createHarness();
		harness.snapshot = snapshotWith({ self: { position: { x: 10.4, y: 70, z: -3.2 } } });

		await expect(
			harness.service.namePlace(harness.execution, { name: "base", position: null }),
		).resolves.toEqual({ name: "base", position: { x: 10, y: 70, z: -4 } });
		await harness.service.setGoal(harness.execution, {
			objective: "Go home",
			targets: {},
			waypoint: "base",
		});

		await vi.waitFor(() => expect(harness.saved.at(-1)?.places).toHaveLength(1));
		expect(harness.service.snapshot().goal?.waypoint).toEqual({ x: 10, y: 70, z: -4 });
		await harness.stop();
	});

	it("反射と死亡を急ぎの出来事として知らせ、死亡はワールドの記憶に残す", async () => {
		const harness = createHarness();
		await harness.service.observe(harness.execution);

		harness.listener().reflexed({ trigger: "lava_or_fire", detail: "moved toward water" });
		harness.listener().died({
			message: "Luna tried to swim in lava",
			position: { x: 1, y: 11, z: 2 },
			dimension: "overworld",
			lostItems: { iron_pickaxe: 1 },
		});

		await vi.waitFor(() => expect(harness.eventTypes()).toEqual(["reflex", "death"]));
		expect(harness.notices.map((notice) => notice.urgent)).toEqual([true, true]);
		expect(JSON.parse(harness.notices[1]?.message.text ?? "")).toMatchObject({
			detail: "Luna tried to swim in lava at (1, 11, 2) in overworld; lost: 1 iron_pickaxe",
		});
		await vi.waitFor(() =>
			expect(harness.saved.at(-1)?.deaths).toEqual([
				expect.objectContaining({ message: "Luna tried to swim in lava" }),
			]),
		);
		await harness.stop();
	});

	it("同じ反射が前の終わりから30秒以内に繰り返したら知らせず、間が空くか別の反射なら知らせる", async () => {
		const harness = createHarness();
		await harness.service.observe(harness.execution);
		const fled = { trigger: "low_health_threat", detail: "ran from zombie" } as const;

		harness.listener().reflexed(fled);
		await vi.waitFor(() => expect(harness.eventTypes()).toEqual(["reflex"]));
		harness.advanceClock(20_000);
		harness.listener().reflexed(fled);
		harness.advanceClock(20_000);
		harness.listener().reflexed(fled);
		harness.listener().reflexed({ trigger: "drowning", detail: "swam up and caught breath" });
		await vi.waitFor(() => expect(harness.eventTypes()).toEqual(["reflex", "reflex"]));
		harness.advanceClock(31_000);
		harness.listener().reflexed({ trigger: "drowning", detail: "swam up and caught breath" });

		await vi.waitFor(() => expect(harness.eventTypes()).toEqual(["reflex", "reflex", "reflex"]));
		expect(
			harness.notices.map(
				(notice) =>
					z.looseObject({ detail: z.string() }).parse(JSON.parse(notice.message.text)).detail,
			),
		).toEqual([
			"low_health_threat: ran from zombie",
			"drowning: swam up and caught breath",
			"drowning: swam up and caught breath",
		]);
		expect(harness.service.snapshot().recentEvents).toHaveLength(3);
		await harness.stop();
	});

	it("切断されたら disconnected を知らせ、待ってから接続し直して前の目標で続ける", async () => {
		const harness = createHarness();
		harness.decide.mockResolvedValue(decision(0, "in_progress"));
		await harness.setGoal();
		await vi.waitFor(() => expect(harness.executed.length).toBeGreaterThan(0));

		harness.listener().disconnected("Kicked: server closed");

		expect(harness.eventTypes()).toEqual(["disconnected"]);
		expect(harness.notices[0]).toMatchObject({ urgent: true, replaceKey: "disconnected" });
		expect(JSON.parse(harness.notices[0]?.message.text ?? "")).toMatchObject({ observation: null });
		expect(harness.service.snapshot().connection).toBe("reconnecting");
		const executed = harness.executed.length;
		harness.runTimer(5_000);

		await vi.waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(harness.executed.length).toBeGreaterThan(executed));
		expect(harness.service.snapshot().connection).toBe("connected");
		await harness.stop();
	});

	it("ほかの出来事がないまま間隔が過ぎたら interval を知らせる", async () => {
		const harness = createHarness();
		await harness.service.observe(harness.execution);

		harness.runTimer(PLANNER_INTERVAL_MS);

		await vi.waitFor(() => expect(harness.eventTypes()).toEqual(["interval"]));
		expect(harness.notices[0]).toMatchObject({ urgent: false, replaceKey: "interval" });
		await harness.stop();
	});

	it("セッションが作業を止めたら判断を止めて接続を閉じ、次の呼び出しで接続し直す", async () => {
		const harness = createHarness();
		harness.decide.mockResolvedValue(decision(0, "in_progress"));
		await harness.setGoal();

		await harness.activities.stopAll();

		expect(harness.close).toHaveBeenCalledOnce();
		expect(harness.service.snapshot()).toMatchObject({ connection: "idle", taskId: null });
		const calls = harness.decide.mock.calls.length;
		await flush();
		expect(harness.decide).toHaveBeenCalledTimes(calls);
	});
});

function decision(choice: number, status: Decision["goal"]["status"]): Decision {
	return { choice, goal: { status, probability: 0.9 } };
}

async function flush(): Promise<void> {
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
	await new Promise((resolve) => {
		setTimeout(resolve, 10);
	});
}

function createHarness() {
	const listeners: ConnectionListener[] = [];
	const executed: MinecraftAction[] = [];
	const saved: WorldMemory[] = [];
	const notices: ActivityNotice[] = [];
	const timers: Array<{ callback: () => void; milliseconds: number; cancelled: boolean }> = [];
	const state: { snapshot: WorldSnapshot; custom: CustomActionsReport } = {
		snapshot: snapshotWith(),
		custom: { loaded: [], candidates: [], errors: [] },
	};
	const clock = { now: Date.parse("2026-11-23T10:00:00.000Z") };

	const observe = vi.fn<MinecraftConnection["observe"]>(async () => state.snapshot);
	const execute = vi.fn<MinecraftConnection["execute"]>(async (action): Promise<ActionOutcome> => {
		executed.push(action);
		await new Promise((resolve) => {
			setTimeout(resolve, 1);
		});
		return { result: "succeeded", detail: "done", chest: null };
	});
	const unknownItems = vi.fn<MinecraftConnection["unknownItems"]>(async () => []);
	const customActions = vi.fn<MinecraftConnection["customActions"]>(async () => state.custom);
	const close = vi.fn<MinecraftConnection["close"]>(async () => {});
	const connect = vi.fn(async (listener: ConnectionListener): Promise<MinecraftConnection> => {
		listeners.push(listener);
		return { observe, execute, unknownItems, customActions, close };
	});
	const decide = vi.fn<
		(input: { state: object; candidates: readonly string[] }) => Promise<Decision>
	>(async () => decision(0, "in_progress"));
	// セッションの作業の表の代わり。始めた作業の後始末を持ち、通知を記録する。
	const stops: Array<() => Promise<void>> = [];
	const activities: ToolActivities & { count(): number; stopAll(): Promise<void> } = {
		begin: (stop) => {
			stops.push(stop);
			return {
				notify: (message, options) => notices.push({ message, ...options }),
				end: () => {},
			};
		},
		count: () => stops.length,
		stopAll: async () => {
			await Promise.all(stops.splice(0).map(async (stop) => await stop()));
		},
	};
	const service = new MinecraftPlayService({
		connect,
		decisions: { decide: async (input) => await decide(input) },
		memory: {
			load: async () => EMPTY_WORLD_MEMORY,
			save: async (memory) => {
				saved.push(memory);
			},
		},
		logger: createRecordingLogger(),
		now: () => new Date(clock.now),
		schedule: (callback, milliseconds) => {
			const timer = { callback, milliseconds, cancelled: false };
			timers.push(timer);
			// 再接続と interval 以外（失敗後や反射中の短い待ち）は、テストでは実際の時間で待つ。
			if (milliseconds < 5_000) {
				const handle = setTimeout(() => {
					if (!timer.cancelled) callback();
				}, 1);
				return () => {
					timer.cancelled = true;
					clearTimeout(handle);
				};
			}
			return () => {
				timer.cancelled = true;
			};
		},
		settings: {
			world: "trial-1",
			decisionTimeoutMs: 3_000,
			plannerIntervalMs: PLANNER_INTERVAL_MS,
		},
	});
	const execution: ToolExecution = {
		ownerId: "owner-1",
		origin: TASK_ORIGIN,
		activities,
		signal: new AbortController().signal,
	};
	return {
		activities,
		close,
		connect,
		decide,
		executed,
		execution,
		notices,
		observe,
		saved,
		service,
		unknownItems,
		get snapshot(): WorldSnapshot {
			return state.snapshot;
		},
		set snapshot(value: WorldSnapshot) {
			state.snapshot = value;
		},
		setCustomActions: (value: CustomActionsReport): void => {
			state.custom = value;
		},
		advanceClock: (milliseconds: number): void => {
			clock.now += milliseconds;
		},
		eventTypes: (): string[] =>
			notices.map((notice) => EventTypeSchema.parse(JSON.parse(notice.message.text)).type),
		listener: (): ConnectionListener => {
			const listener = listeners.at(-1);
			if (listener === undefined) throw new Error("not connected");
			return listener;
		},
		runTimer: (milliseconds: number): void => {
			const timer = timers.findLast(
				(entry) => entry.milliseconds === milliseconds && !entry.cancelled,
			);
			if (timer === undefined) throw new Error(`no timer for ${String(milliseconds)}ms`);
			timer.cancelled = true;
			timer.callback();
		},
		setGoal: async (): Promise<void> => {
			await service.setGoal(execution, {
				objective: "Collect 4 oak logs",
				targets: { oak_log: 4 },
				waypoint: null,
			});
		},
		stop: async (): Promise<void> => {
			await service.stop();
		},
	};
}
