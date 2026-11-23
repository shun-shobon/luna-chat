import { describe, expect, it } from "vitest";

import { judgeReflex } from "./reflex";
import type { ReflexState } from "./reflex";

const SAFE: ReflexState = {
	inLava: false,
	burning: false,
	inWater: false,
	headInWater: false,
	oxygen: 20,
	health: 20,
	food: 20,
	hostileVisible: false,
	hasFood: false,
};

describe("judgeReflex", () => {
	it.each([
		["安全なら動かない", SAFE, null],
		["溶岩に触れている", { ...SAFE, inLava: true }, "lava_or_fire"],
		["燃えている", { ...SAFE, burning: true }, "lava_or_fire"],
		[
			"頭まで水に入り酸素が10以下",
			{ ...SAFE, inWater: true, headInWater: true, oxygen: 10 },
			"drowning",
		],
		[
			"水中でも酸素が残っていれば動かない",
			{ ...SAFE, inWater: true, headInWater: true, oxygen: 11 },
			null,
		],
		[
			"体力8以下で敵が見えている",
			{ ...SAFE, health: 8, hostileVisible: true },
			"low_health_threat",
		],
		[
			"体力8以下で空腹で食料がある",
			{ ...SAFE, health: 8, food: 15, hasFood: true },
			"low_health_hungry",
		],
		["体力8以下でも満腹なら食べない", { ...SAFE, health: 8, hasFood: true }, null],
		[
			"溶岩は体力より優先する",
			{ ...SAFE, inLava: true, health: 3, hostileVisible: true },
			"lava_or_fire",
		],
	] as const)("%s", (_label, state, expected) => {
		expect(judgeReflex(state)).toBe(expected);
	});
});
