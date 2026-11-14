import { describe, expect, it } from "vitest";

import { listEntities } from "./entity-listing";
import type { EntityPlacement } from "./entity-listing";
import type { HomeAssistantState } from "./state-change";

const STATES: readonly HomeAssistantState[] = [
	state("light.kitchen", "on", "キッチンの照明"),
	state("light.living", "off", "Living Light"),
	state("switch.fan", "on", "扇風機"),
	state("sensor.kitchen_temperature", "22", null),
];

const PLACEMENTS: ReadonlyMap<string, EntityPlacement> = new Map([
	["light.kitchen", { areaId: "kitchen", areaName: "キッチン", deviceName: "天井灯" }],
	["switch.fan", { areaId: "kitchen", areaName: "キッチン", deviceName: null }],
	["light.living", { areaId: "living_room", areaName: "Living Room", deviceName: "Lamp" }],
]);

describe("listEntities", () => {
	it("条件なしならすべてを属性なしの要約で返す", () => {
		const result = listEntities(STATES, { max: 200 }, undefined);

		expect(result).toEqual({
			entities: [
				{ entity_id: "light.kitchen", state: "on", friendly_name: "キッチンの照明" },
				{ entity_id: "light.living", state: "off", friendly_name: "Living Light" },
				{ entity_id: "switch.fan", state: "on", friendly_name: "扇風機" },
				{ entity_id: "sensor.kitchen_temperature", state: "22", friendly_name: null },
			],
			total: 4,
			truncated: false,
		});
	});

	it("entity_idsを指定すると他の条件より優先する", () => {
		const result = listEntities(
			STATES,
			{ entityIds: ["switch.fan"], domain: "light", name: "kitchen", max: 200 },
			undefined,
		);

		expect(result.entities.map((entity) => entity.entity_id)).toEqual(["switch.fan"]);
	});

	it("domainはentity_idの接頭辞で完全一致させる", () => {
		const result = listEntities(STATES, { domain: "light", max: 200 }, undefined);

		expect(result.entities.map((entity) => entity.entity_id)).toEqual([
			"light.kitchen",
			"light.living",
		]);
	});

	it.each([["kitchen"], ["キッチン"], ["KITCHEN"]])(
		"areaはエリアのIDか名前に大文字小文字を区別せず一致させる (%s)",
		(area) => {
			const result = listEntities(STATES, { area, max: 200 }, PLACEMENTS);

			expect(result.entities.map((entity) => entity.entity_id)).toEqual([
				"light.kitchen",
				"switch.fan",
			]);
		},
	);

	it("nameはentity_idかfriendly_nameに大文字小文字を区別せず含まれれば一致させる", () => {
		expect(
			listEntities(STATES, { name: "KITCHEN", max: 200 }, undefined).entities.map(
				(entity) => entity.entity_id,
			),
		).toEqual(["light.kitchen", "sensor.kitchen_temperature"]);
		expect(
			listEntities(STATES, { name: "living light", max: 200 }, undefined).entities.map(
				(entity) => entity.entity_id,
			),
		).toEqual(["light.living"]);
	});

	it("maxで切った場合はtruncatedを真にし、totalは絞り込み後の件数にする", () => {
		const result = listEntities(STATES, { max: 2 }, undefined);

		expect(result.entities).toHaveLength(2);
		expect(result.total).toBe(4);
		expect(result.truncated).toBe(true);
	});

	it("登録情報があれば各要素にエリアとデバイスを付け、ないものはnullにする", () => {
		const result = listEntities(STATES, { domain: "sensor", max: 200 }, PLACEMENTS);
		const kitchen = listEntities(STATES, { entityIds: ["light.kitchen"], max: 200 }, PLACEMENTS);

		expect(result.entities[0]).toEqual({
			entity_id: "sensor.kitchen_temperature",
			state: "22",
			friendly_name: null,
			area: null,
			device: null,
		});
		expect(kitchen.entities[0]).toMatchObject({ area: "キッチン", device: "天井灯" });
	});
});

function state(entityId: string, value: string, friendlyName: string | null): HomeAssistantState {
	return {
		entityId,
		state: value,
		attributes: friendlyName == null ? {} : { friendly_name: friendlyName, brightness: 255 },
		lastChanged: "2026-11-14T00:00:00.000Z",
		lastUpdated: "2026-11-14T00:00:00.000Z",
	};
}
