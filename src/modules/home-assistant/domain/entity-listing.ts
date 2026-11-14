import type { HomeAssistantState } from "./state-change";

export type EntityPlacement = Readonly<{
	areaId: string | null;
	areaName: string | null;
	deviceName: string | null;
}>;

export type EntityListQuery = Readonly<{
	domain?: string | undefined;
	area?: string | undefined;
	name?: string | undefined;
	entityIds?: readonly string[] | undefined;
	max: number;
}>;

type EntitySummary = Readonly<{
	entity_id: string;
	state: string;
	friendly_name: string | null;
	area?: string | null;
	device?: string | null;
}>;

export type EntityList = Readonly<{
	entities: readonly EntitySummary[];
	total: number;
	truncated: boolean;
}>;

export function listEntities(
	states: readonly HomeAssistantState[],
	query: EntityListQuery,
	placements: ReadonlyMap<string, EntityPlacement> | undefined,
): EntityList {
	const matched = states.filter((state) => matchesQuery(state, query, placements));
	const entities = matched.slice(0, query.max).map((state): EntitySummary => {
		if (placements === undefined) {
			return { entity_id: state.entityId, state: state.state, friendly_name: friendlyName(state) };
		}
		const placement = placements.get(state.entityId);
		return {
			entity_id: state.entityId,
			state: state.state,
			friendly_name: friendlyName(state),
			area: placement?.areaName ?? null,
			device: placement?.deviceName ?? null,
		};
	});
	return { entities, total: matched.length, truncated: matched.length > query.max };
}

function matchesQuery(
	state: HomeAssistantState,
	query: EntityListQuery,
	placements: ReadonlyMap<string, EntityPlacement> | undefined,
): boolean {
	if (query.entityIds !== undefined) return query.entityIds.includes(state.entityId);
	if (query.domain !== undefined && !state.entityId.startsWith(`${query.domain}.`)) return false;
	if (query.area !== undefined) {
		const placement = placements?.get(state.entityId);
		const area = query.area.toLowerCase();
		if (placement?.areaId?.toLowerCase() !== area && placement?.areaName?.toLowerCase() !== area) {
			return false;
		}
	}
	if (query.name !== undefined) {
		const name = query.name.toLowerCase();
		const candidates = [state.entityId, friendlyName(state) ?? ""];
		if (!candidates.some((candidate) => candidate.toLowerCase().includes(name))) return false;
	}
	return true;
}

function friendlyName(state: HomeAssistantState): string | null {
	const value = state.attributes["friendly_name"];
	return typeof value === "string" ? value : null;
}
