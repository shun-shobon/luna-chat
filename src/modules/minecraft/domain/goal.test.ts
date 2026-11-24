import { describe, expect, it } from "vitest";

import { changedDuringInference, GoalTracker, targetsMet } from "./goal";

describe("GoalTracker", () => {
	it("確率0.8以上の done が2回続いたら goal_done にする", () => {
		const tracker = new GoalTracker();

		expect(tracker.answered({ status: "done", probability: 0.9 })).toBeNull();
		expect(tracker.answered({ status: "done", probability: 0.8 })).toBe("goal_done");
	});

	it("確率の低い答えや別の答えが挟まったら数え直す", () => {
		const tracker = new GoalTracker();

		tracker.answered({ status: "done", probability: 0.95 });
		tracker.answered({ status: "done", probability: 0.6 });
		expect(tracker.answered({ status: "done", probability: 0.95 })).toBeNull();
		tracker.answered({ status: "in_progress", probability: 0.9 });
		expect(tracker.answered({ status: "done", probability: 0.95 })).toBeNull();
	});

	it("確率0.8以上の stuck が3回続いたら goal_stuck にする", () => {
		const tracker = new GoalTracker();

		tracker.answered({ status: "stuck", probability: 0.9 });
		tracker.answered({ status: "stuck", probability: 0.9 });
		expect(tracker.answered({ status: "stuck", probability: 0.9 })).toBe("goal_stuck");
	});

	it("行動の失敗が3回続いたら goal_stuck にし、成功で数え直す", () => {
		const tracker = new GoalTracker();

		tracker.acted(false);
		tracker.acted(false);
		tracker.acted(true);
		tracker.acted(false);
		tracker.acted(false);
		expect(tracker.acted(false)).toBe("goal_stuck");
	});

	it("reset で前の目標の数えを捨てる", () => {
		const tracker = new GoalTracker();
		tracker.acted(false);
		tracker.acted(false);
		tracker.answered({ status: "done", probability: 0.9 });

		tracker.reset();

		expect(tracker.acted(false)).toBeNull();
		expect(tracker.answered({ status: "done", probability: 0.9 })).toBeNull();
	});

	it("答えを3回続けて捨てたら行動の失敗1回と数える", () => {
		const tracker = new GoalTracker();
		tracker.acted(false);
		tracker.acted(false);

		expect(tracker.discarded()).toBeNull();
		expect(tracker.discarded()).toBeNull();
		expect(tracker.discarded()).toBe("goal_stuck");
	});
});

describe("changedDuringInference", () => {
	const before = { position: { x: 0, y: 64, z: 0 }, health: 20, hostileIds: [7] };

	it.each([
		["1ブロック以上動いた", { ...before, position: { x: 0.8, y: 64, z: 0.7 } }, true],
		["体力が減った", { ...before, health: 18 }, true],
		["新しい敵が見えた", { ...before, hostileIds: [7, 9] }, true],
		[
			"少し動き、敵が見えなくなっただけ",
			{ ...before, position: { x: 0.5, y: 64, z: 0 }, hostileIds: [] },
			false,
		],
	])("%s", (_label, after, changed) => {
		expect(changedDuringInference(before, after)).toBe(changed);
	});
});

describe("targetsMet", () => {
	const goal = { objective: "Collect", targets: { oak_log: 3, stick: 2 }, waypoint: null };

	it("持ち物がすべての targets を満たした時だけ真にする", () => {
		expect(targetsMet(goal, { oak_log: 3, stick: 2, dirt: 9 })).toBe(true);
		expect(targetsMet(goal, { oak_log: 5, stick: 1 })).toBe(false);
	});

	it("targets のない目標は持ち物では決めない", () => {
		expect(targetsMet({ ...goal, targets: {} }, { oak_log: 3 })).toBe(false);
	});
});
