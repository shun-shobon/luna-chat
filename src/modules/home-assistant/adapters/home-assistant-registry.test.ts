import { describe, expect, it, vi } from "vitest";

import { HomeAssistantRegistry } from "./home-assistant-registry";

describe("HomeAssistantRegistry", () => {
	it("エンティティ自身のエリアを優先し、なければデバイスのエリアを使う", async () => {
		const { registry } = createRegistry();

		const placements = await registry.entityPlacements();

		expect(placements.get("light.kitchen")).toEqual({
			areaId: "kitchen",
			areaName: "キッチン",
			deviceName: "天井灯",
		});
		expect(placements.get("switch.fan")).toEqual({
			areaId: "living",
			areaName: "リビング",
			deviceName: "Fan Plug",
		});
		expect(placements.get("sensor.orphan")).toEqual({
			areaId: null,
			areaName: null,
			deviceName: null,
		});
	});

	it("5分間は登録情報をキャッシュし、期限が切れたら取り直す", async () => {
		const { registry, request, advance } = createRegistry();

		await registry.entityPlacements();
		advance(299_999);
		await registry.entityPlacements();
		expect(request).toHaveBeenCalledTimes(3);
		advance(1);
		await registry.entityPlacements();

		expect(request).toHaveBeenCalledTimes(6);
	});

	it("形の合わない結果はエラーにする", async () => {
		const { registry } = createRegistry({ "config/area_registry/list": [{ id: "x" }] });

		await expect(registry.entityPlacements()).rejects.toThrow(
			"Home Assistant returned an unexpected config/area_registry/list result",
		);
	});
});

function createRegistry(overrides: Record<string, unknown> = {}) {
	let now = new Date("2026-11-14T00:00:00.000Z");
	const results: Record<string, unknown> = {
		"config/area_registry/list": [
			{ area_id: "kitchen", name: "キッチン" },
			{ area_id: "living", name: "リビング" },
		],
		"config/device_registry/list": [
			{ id: "d1", area_id: "living", name: "Ceiling", name_by_user: "天井灯" },
			{ id: "d2", area_id: "living", name: "Fan Plug", name_by_user: null },
		],
		"config/entity_registry/list": [
			{ entity_id: "light.kitchen", area_id: "kitchen", device_id: "d1" },
			{ entity_id: "switch.fan", area_id: null, device_id: "d2" },
			{ entity_id: "sensor.orphan", area_id: null, device_id: null },
		],
		...overrides,
	};
	const request = vi.fn(
		async (message: Readonly<Record<string, unknown>>): Promise<unknown> =>
			await Promise.resolve(results[String(message["type"])]),
	);
	return {
		registry: new HomeAssistantRegistry({ connection: { request }, now: () => now }),
		request,
		advance: (milliseconds: number): void => {
			now = new Date(now.getTime() + milliseconds);
		},
	};
}
