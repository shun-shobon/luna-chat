import { describe, expect, it } from "vitest";

import { createStateChangedEvent, findStateChangeTrigger } from "./state-change";
import type { HomeAssistantState, StateChange, WatchConfig } from "./state-change";

const NOW = new Date("2026-11-14T10:00:00.000Z");
const CONFIG: WatchConfig = { watch: ["binary_sensor.*"], ignore: [], cooldownSeconds: 30 };

describe("findStateChangeTrigger", () => {
	it("watchに一致しstateが変わった変化を起動の対象にする", () => {
		const change = stateChange("off", "on");

		expect(
			findStateChangeTrigger({ change, config: CONFIG, lastTriggeredAt: undefined, now: NOW }),
		).toEqual({
			entityId: "binary_sensor.front_door",
			oldState: change.oldState,
			newState: change.newState,
		});
	});

	it.each([
		["変化前がない", { ...stateChange("off", "on"), oldState: null }],
		["変化後がない", { ...stateChange("off", "on"), newState: null }],
		["stateが同じ（属性だけの変化）", stateChange("on", "on")],
	])("%s変化は対象にしない", (_label, change) => {
		expect(
			findStateChangeTrigger({ change, config: CONFIG, lastTriggeredAt: undefined, now: NOW }),
		).toBeUndefined();
	});

	it("watchに一致しない変化は対象にしない", () => {
		expect(
			findStateChangeTrigger({
				change: stateChange("off", "on"),
				config: { ...CONFIG, watch: ["light.*"] },
				lastTriggeredAt: undefined,
				now: NOW,
			}),
		).toBeUndefined();
	});

	it("ignoreに一致する変化はwatchに一致しても対象にしない", () => {
		expect(
			findStateChangeTrigger({
				change: stateChange("off", "on"),
				config: { ...CONFIG, ignore: ["*front_door"] },
				lastTriggeredAt: undefined,
				now: NOW,
			}),
		).toBeUndefined();
	});

	it.each([
		["cooldownの途中", 29_999, false],
		["cooldownちょうど", 30_000, true],
		["cooldownの超過", 30_001, true],
	])("前回の起動から%sなら対象かどうかは%s", (_label, elapsedMs, expected) => {
		const trigger = findStateChangeTrigger({
			change: stateChange("off", "on"),
			config: CONFIG,
			lastTriggeredAt: new Date(NOW.getTime() - elapsedMs),
			now: NOW,
		});

		expect(trigger !== undefined).toBe(expected);
	});
});

describe("createStateChangedEvent", () => {
	it("変化後の属性から名前・単位・種類を取り出し、変化後のlast_changedを発生時刻にする", () => {
		const change = stateChange("21.5", "23", {
			friendly_name: "リビングの温度",
			unit_of_measurement: "°C",
			device_class: "temperature",
		});

		const event = createStateChangedEvent(
			{
				entityId: change.entityId,
				oldState: state("21.5"),
				newState: change.newState ?? state(""),
			},
			"event-1",
		);

		expect(event).toEqual({
			id: "event-1",
			type: "home_assistant.state_changed.v1",
			source: "home_assistant",
			subject: "binary_sensor.front_door",
			occurredAt: "2026-11-14T09:59:59.000Z",
			data: {
				entity_id: "binary_sensor.front_door",
				friendly_name: "リビングの温度",
				old_state: "21.5",
				new_state: "23",
				unit: "°C",
				device_class: "temperature",
			},
		});
	});

	it("文字列でない属性やない属性はnullにする", () => {
		const event = createStateChangedEvent(
			{
				entityId: "sensor.x",
				oldState: state("1"),
				newState: state("2", { friendly_name: 3 }),
			},
			"event-2",
		);

		expect(event.data).toMatchObject({ friendly_name: null, unit: null, device_class: null });
	});
});

function stateChange(
	oldValue: string,
	newValue: string,
	attributes: Record<string, unknown> = {},
): StateChange {
	return {
		entityId: "binary_sensor.front_door",
		oldState: state(oldValue),
		newState: state(newValue, attributes),
	};
}

function state(value: string, attributes: Record<string, unknown> = {}): HomeAssistantState {
	return {
		entityId: "binary_sensor.front_door",
		state: value,
		attributes,
		lastChanged: "2026-11-14T09:59:59.000Z",
		lastUpdated: "2026-11-14T09:59:59.000Z",
	};
}
