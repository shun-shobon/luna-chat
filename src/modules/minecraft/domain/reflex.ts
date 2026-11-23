import { z } from "zod";

// SPEC §25.5 のしきい値。体力・満腹度・酸素はどれも 0〜20。
const LOW_HEALTH = 8;
// 6 では、浮いても次の行動でまた潜り、浮き切る前に溺れた。
const LOW_OXYGEN = 10;
const FULL_FOOD = 20;
export const REFLEX_LIMIT_MS = 10_000;
// 体力が低い時に敵から離れる距離（ブロック）。
export const FLEE_DISTANCE = 16;
// この距離（ブロック）以内に新しい敵が見えたら、行動と推論中の答えを捨てて判断し直す（SPEC §25.4）。
export const THREAT_DISTANCE = 16;
// 溶岩・火から逃げる時に、水を目指す距離（ブロック）。
export const WATER_ESCAPE_DISTANCE = 4;

export const reflexTriggerSchema = z.enum([
	"lava_or_fire",
	"drowning",
	"low_health_threat",
	"low_health_hungry",
]);
export type ReflexTrigger = z.infer<typeof reflexTriggerSchema>;

export type ReflexState = Readonly<{
	inLava: boolean;
	burning: boolean;
	inWater: boolean;
	headInWater: boolean;
	oxygen: number;
	health: number;
	food: number;
	hostileVisible: boolean;
	hasFood: boolean;
}>;

// 毎tick呼び、決定モデルと計画役を待たずに動くべき危険があれば、その種類を返す。上の行ほど優先する。
export function judgeReflex(state: ReflexState): ReflexTrigger | null {
	if (state.inLava || state.burning) return "lava_or_fire";
	if (state.inWater && state.headInWater && state.oxygen <= LOW_OXYGEN) return "drowning";
	if (state.health <= LOW_HEALTH && state.hostileVisible) return "low_health_threat";
	if (state.health <= LOW_HEALTH && state.food < FULL_FOOD && state.hasFood) {
		return "low_health_hungry";
	}
	return null;
}
