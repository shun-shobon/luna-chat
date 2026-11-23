import type { Vec3 } from "./world";

// 計画役が minecraft_goal で置いた目標。場所の名前は位置にして持つ。
export type MinecraftGoal = Readonly<{
	objective: string;
	targets: Readonly<Record<string, number>>;
	waypoint: Vec3 | null;
}>;

export type GoalStatus = "done" | "in_progress" | "stuck";

export type GoalAnswer = Readonly<{ status: GoalStatus; probability: number }>;

// SPEC §25.4 のしきい値。確率がこれ以上の答えを、続けて数える。
const CONFIDENT_PROBABILITY = 0.8;
const DONE_STREAK = 2;
const STUCK_STREAK = 3;
const FAILURE_STREAK = 3;
const STALE_STREAK = 3;

export type GoalVerdict = "goal_done" | "goal_stuck" | null;

// 1手ごとの答えと行動の結果を数え、目標の状態を計画役へ通知するかを決める。
export class GoalTracker {
	#done = 0;
	#failures = 0;
	#stale = 0;
	#stuck = 0;

	// 新しい目標を置いた時に、前の目標の数えをすべて捨てる。
	reset(): void {
		this.#done = 0;
		this.#failures = 0;
		this.#stale = 0;
		this.#stuck = 0;
	}

	answered(answer: GoalAnswer): GoalVerdict {
		this.#stale = 0;
		const confident = answer.probability >= CONFIDENT_PROBABILITY;
		this.#done = confident && answer.status === "done" ? this.#done + 1 : 0;
		this.#stuck = confident && answer.status === "stuck" ? this.#stuck + 1 : 0;
		if (this.#done >= DONE_STREAK) return "goal_done";
		if (this.#stuck >= STUCK_STREAK) return "goal_stuck";
		return null;
	}

	acted(succeeded: boolean): GoalVerdict {
		this.#failures = succeeded ? 0 : this.#failures + 1;
		return this.#failures >= FAILURE_STREAK ? "goal_stuck" : null;
	}

	// 推論の間に状況が変わり、答えを捨てた時に呼ぶ。続けて捨てたら行動の失敗1回と数える。
	discarded(): GoalVerdict {
		this.#stale += 1;
		if (this.#stale < STALE_STREAK) return null;
		this.#stale = 0;
		return this.acted(false);
	}
}

// 推論の前後の観測を比べ、答えを捨てるべき変化（SPEC §25.4 の手順3）があったかを返す。
export function changedDuringInference(
	before: Readonly<{ position: Vec3; health: number; hostileIds: readonly number[] }>,
	after: Readonly<{ position: Vec3; health: number; hostileIds: readonly number[] }>,
): boolean {
	const moved =
		Math.hypot(
			after.position.x - before.position.x,
			after.position.y - before.position.y,
			after.position.z - before.position.z,
		) >= 1;
	const hurt = after.health < before.health;
	const known = new Set(before.hostileIds);
	return moved || hurt || after.hostileIds.some((id) => !known.has(id));
}
