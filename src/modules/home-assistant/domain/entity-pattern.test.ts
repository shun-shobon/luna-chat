import { describe, expect, it } from "vitest";

import { matchesAnyEntityPattern, matchesEntityPattern } from "./entity-pattern";

describe("matchesEntityPattern", () => {
	it.each([
		["binary_sensor.front_door", "binary_sensor.front_door", true],
		["binary_sensor.front_door", "binary_sensor.front_door_2", false],
		["climate.*", "climate.living", true],
		["climate.*", "sensor.climate_living", false],
		["*_battery", "sensor.phone_battery", true],
		["*_battery", "sensor.phone_battery_level", false],
		["sensor.*_temperature", "sensor.kitchen_temperature", true],
		["*", "light.kitchen", true],
		["*kitchen*", "light.kitchen_main", true],
		["light.kitchen", "lightXkitchen", false],
		["sensor.a+b", "sensor.a+b", true],
		["sensor.a+b", "sensor.aab", false],
		["sensor.(x)", "sensor.(x)", true],
	])("パターン %s と %s の一致は %s", (pattern, entityId, expected) => {
		expect(matchesEntityPattern(pattern, entityId)).toBe(expected);
	});
});

describe("matchesAnyEntityPattern", () => {
	it("いずれかのパターンに一致すれば真、空の一覧なら偽を返す", () => {
		expect(matchesAnyEntityPattern(["light.*", "switch.fan"], "switch.fan")).toBe(true);
		expect(matchesAnyEntityPattern(["light.*"], "switch.fan")).toBe(false);
		expect(matchesAnyEntityPattern([], "switch.fan")).toBe(false);
	});
});
