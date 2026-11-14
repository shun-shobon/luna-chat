import { describe, expect, it, vi } from "vitest";

import { createRecordingLogger } from "../../observability/testing/recording-logger";
import { createToolSet } from "../../tool/application/tool-set";
import type { ToolOrigin } from "../../tool/domain/tool";
import type { HomeAssistantState } from "../domain/state-change";
import type {
	HomeAssistantRegistryPort,
	HomeAssistantRestPort,
	HomeAssistantServiceDomain,
} from "../ports/home-assistant-api-port";
import { createHomeAssistantToolProvider } from "./home-assistant-tool-provider";

const SERVICES: readonly HomeAssistantServiceDomain[] = [
	{ domain: "light", services: { turn_on: { fields: {} } } },
	{ domain: "switch", services: { toggle: { fields: {} } } },
];
const origin: ToolOrigin = { kind: "event", eventId: "event-1", eventType: "test.v1" };

describe("createHomeAssistantToolProvider", () => {
	it("4つのツールを提供し、入力スキーマからJSON Schemaを生成できる", () => {
		const { tools } = createHarness();

		expect(tools.map((tool) => tool.name)).toEqual([
			"ha_list_entities",
			"ha_get_state",
			"ha_list_services",
			"ha_call_service",
		]);
		for (const tool of tools) expect(tool.parameters).toMatchObject({ type: "object" });
	});

	it("ha_list_entitiesはareaを指定しなければ登録情報を引かずに一覧を返す", async () => {
		const { registry, run } = createHarness();

		const result = await run("ha_list_entities", { domain: "light" });

		expect(registry.entityPlacements).not.toHaveBeenCalled();
		expect(JSON.parse(result.text)).toEqual({
			entities: [{ entity_id: "light.kitchen", state: "on", friendly_name: "キッチン" }],
			total: 1,
			truncated: false,
		});
	});

	it("ha_list_entitiesはareaを指定すると登録情報でエリアとデバイスを付ける", async () => {
		const { registry, run } = createHarness();

		const result = await run("ha_list_entities", { area: "キッチン" });

		expect(registry.entityPlacements).toHaveBeenCalledOnce();
		expect(JSON.parse(result.text)).toMatchObject({
			entities: [{ entity_id: "light.kitchen", area: "キッチン", device: "天井灯" }],
		});
	});

	it("ha_list_entitiesはmaxを省略すると200件までにする", async () => {
		const states = Array.from({ length: 201 }, (_value, index) =>
			state(`sensor.s${String(index)}`, "1"),
		);
		const { run } = createHarness({ listStates: vi.fn(async () => states) });

		const result: unknown = JSON.parse((await run("ha_list_entities", {})).text);

		expect(result).toHaveProperty("entities.length", 200);
		expect(result).toMatchObject({ total: 201, truncated: true });
	});

	it("ha_get_stateは属性を含む状態を返し、存在しなければツールの失敗にする", async () => {
		const { run } = createHarness();

		const found = await run("ha_get_state", { entity_id: "light.kitchen" });
		const missing = await run("ha_get_state", { entity_id: "light.missing" });

		expect(JSON.parse(found.text)).toEqual({
			entity_id: "light.kitchen",
			state: "on",
			attributes: { friendly_name: "キッチン", brightness: 200 },
			last_changed: "2026-11-14T00:00:00.000Z",
			last_updated: "2026-11-14T00:00:01.000Z",
		});
		expect(missing).toMatchObject({
			isError: true,
			text: "Home Assistant entity not found: light.missing.",
		});
	});

	it("ha_list_servicesはdomainで絞り込む", async () => {
		const { run } = createHarness();

		const result = await run("ha_list_services", { domain: "light" });

		expect(JSON.parse(result.text)).toEqual([
			{ domain: "light", services: { turn_on: { fields: {} } } },
		]);
	});

	it("ha_call_serviceはdataにentity_idを加えて呼び、変化した状態を縮めて返す", async () => {
		const { rest, run } = createHarness();

		const result = await run("ha_call_service", {
			domain: "light",
			service: "turn_on",
			entity_id: ["light.kitchen", "light.living"],
			data: { brightness_pct: 50 },
		});

		expect(rest.callService).toHaveBeenCalledWith(
			{
				domain: "light",
				service: "turn_on",
				data: { brightness_pct: 50, entity_id: ["light.kitchen", "light.living"] },
				returnResponse: false,
			},
			expect.any(AbortSignal),
		);
		expect(JSON.parse(result.text)).toEqual({
			changed_states: [{ entity_id: "light.kitchen", state: "on" }],
		});
	});

	it("ha_call_serviceはreturn_responseならservice_responseも返す", async () => {
		const { rest, run } = createHarness({
			callService: vi.fn(async () => ({
				changedStates: [],
				serviceResponse: { "weather.home": { forecast: [] } },
			})),
		});

		const result = await run("ha_call_service", {
			domain: "weather",
			service: "get_forecasts",
			data: { type: "daily" },
			return_response: true,
		});

		expect(rest.callService).toHaveBeenCalledWith(
			expect.objectContaining({ data: { type: "daily" }, returnResponse: true }),
			expect.any(AbortSignal),
		);
		expect(JSON.parse(result.text)).toEqual({
			changed_states: [],
			service_response: { "weather.home": { forecast: [] } },
		});
	});

	it.each([
		["ha_call_service", { domain: "shell_command/../light", service: "turn_on" }],
		["ha_call_service", { domain: "light", service: "Turn On" }],
		["ha_call_service", { domain: "light", service: "turn_on", entity_id: "kitchen" }],
		["ha_get_state", { entity_id: "light.kitchen/../x" }],
		["ha_list_entities", { max: 0 }],
	])("%sの形式に合わない入力は検証エラーにして呼び出さない (%o)", async (name, input) => {
		const { rest, run } = createHarness();

		const result = await run(name, input);

		expect(result.isError).toBe(true);
		expect(rest.callService).not.toHaveBeenCalled();
		expect(rest.getState).not.toHaveBeenCalled();
		expect(rest.listStates).not.toHaveBeenCalled();
	});
});

function createHarness(overrides: Partial<HomeAssistantRestPort> = {}) {
	const rest = {
		listStates: vi.fn(async () => [state("light.kitchen", "on"), state("switch.fan", "off")]),
		getState: vi.fn(async (entityId: string) =>
			entityId === "light.kitchen" ? state("light.kitchen", "on") : undefined,
		),
		listServices: vi.fn(async () => SERVICES),
		callService: vi.fn(async () => ({
			changedStates: [state("light.kitchen", "on")],
			serviceResponse: undefined,
		})),
		...overrides,
	} satisfies HomeAssistantRestPort;
	const registry = {
		entityPlacements: vi.fn(
			async () =>
				new Map([
					["light.kitchen", { areaId: "kitchen", areaName: "キッチン", deviceName: "天井灯" }],
				]),
		),
	} satisfies HomeAssistantRegistryPort;
	const tools = createToolSet(
		[createHomeAssistantToolProvider({ rest, registry })],
		createRecordingLogger(),
	).bind({ ownerId: "owner-1", origin });
	const run = async (name: string, input: unknown) => {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool === undefined) throw new Error(`tool ${name} is missing`);
		return await tool.execute(input, new AbortController().signal);
	};
	return { registry, rest, run, tools };
}

function state(entityId: string, value: string): HomeAssistantState {
	return {
		entityId,
		state: value,
		attributes: entityId === "light.kitchen" ? { friendly_name: "キッチン", brightness: 200 } : {},
		lastChanged: "2026-11-14T00:00:00.000Z",
		lastUpdated: "2026-11-14T00:00:01.000Z",
	};
}
