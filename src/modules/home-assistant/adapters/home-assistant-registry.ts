import { z } from "zod";

import type {
	HomeAssistantRegistryEntry,
	HomeAssistantRegistryPort,
} from "../ports/home-assistant-api-port";
import { HomeAssistantConnectionError } from "./home-assistant-connection";

// エリアやデバイスの付け替えは稀で、一覧のたびに3種類の登録情報を引き直すほどではない。
const CACHE_TTL_MS = 300_000;

const areasSchema = z.array(z.looseObject({ area_id: z.string(), name: z.string() }));
const devicesSchema = z.array(
	z.looseObject({
		id: z.string(),
		area_id: z.string().nullable(),
		name: z.string().nullable(),
		name_by_user: z.string().nullable(),
	}),
);
const entitiesSchema = z.array(
	z.looseObject({
		entity_id: z.string(),
		area_id: z.string().nullable(),
		device_id: z.string().nullable(),
	}),
);

type Requester = Readonly<{
	request(message: Readonly<Record<string, unknown>>): Promise<unknown>;
}>;

type CachedPlacements = Readonly<{
	expiresAt: number;
	placements: ReadonlyMap<string, HomeAssistantRegistryEntry>;
}>;

export class HomeAssistantRegistry implements HomeAssistantRegistryPort {
	#cache: CachedPlacements | undefined;

	constructor(
		private readonly dependencies: Readonly<{ connection: Requester; now: () => Date }>,
	) {}

	async entityPlacements(): Promise<ReadonlyMap<string, HomeAssistantRegistryEntry>> {
		const now = this.dependencies.now().getTime();
		if (this.#cache !== undefined && this.#cache.expiresAt > now) return this.#cache.placements;

		const [areas, devices, entities] = await Promise.all([
			this.#list("config/area_registry/list", areasSchema),
			this.#list("config/device_registry/list", devicesSchema),
			this.#list("config/entity_registry/list", entitiesSchema),
		]);
		const areaNames = new Map(areas.map((area) => [area.area_id, area.name]));
		const devicesById = new Map(devices.map((device) => [device.id, device]));
		const placements = new Map<string, HomeAssistantRegistryEntry>();
		for (const entity of entities) {
			const device = entity.device_id == null ? undefined : devicesById.get(entity.device_id);
			const areaId = entity.area_id ?? device?.area_id ?? null;
			placements.set(entity.entity_id, {
				areaId,
				areaName: areaId == null ? null : (areaNames.get(areaId) ?? null),
				deviceName: device === undefined ? null : (device.name_by_user ?? device.name),
			});
		}
		this.#cache = { expiresAt: now + CACHE_TTL_MS, placements };
		return placements;
	}

	async #list<T>(type: string, schema: z.ZodType<T>): Promise<T> {
		const result = schema.safeParse(await this.dependencies.connection.request({ type }));
		if (!result.success) {
			throw new HomeAssistantConnectionError(
				`Home Assistant returned an unexpected ${type} result: ${z.prettifyError(result.error)}`,
			);
		}
		return result.data;
	}
}
