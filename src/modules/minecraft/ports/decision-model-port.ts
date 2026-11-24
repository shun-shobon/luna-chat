import type { JsonObject } from "../../../shared/json";
import type { GoalAnswer } from "../domain/goal";

export type DecisionInput = Readonly<{
	state: JsonObject;
	// 行動の候補の説明。答えはこの並びの番号で返す。
	candidates: readonly string[];
}>;

export type Decision = Readonly<{ choice: number; goal: GoalAnswer }>;

export interface DecisionModelPort {
	// 失敗とタイムアウトは例外にする（再試行しない）。
	decide(input: DecisionInput, signal: AbortSignal): Promise<Decision>;
}
