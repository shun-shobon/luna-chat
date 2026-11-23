import type { JsonObject } from "../../../shared/json";
import type { GoalAnswer, MinecraftGoal } from "./goal";
import { distanceBetween, SIGHT_DISTANCE } from "./world";
import type { Vec3, WorldSnapshot } from "./world";
import type { WorldMemory } from "./world-memory";

const ENTITY_LIMIT = 16;
const PER_BLOCK_KIND = 3;
const PLACE_LIMIT = 16;
const RECENT_ACTION_LIMIT = 5;

export type ActionRecord = Readonly<{
	action: string;
	result: "succeeded" | "failed" | "interrupted";
	detail: string;
	at: string;
}>;

export type ReflexRecord = Readonly<{ trigger: string; at: string }>;

// 決定モデルと計画役に渡す観測（SPEC §25.3 の MinecraftObservation）。
export function buildObservation(
	input: Readonly<{
		snapshot: WorldSnapshot;
		memory: WorldMemory;
		goal: MinecraftGoal | null;
		recentActions: readonly ActionRecord[];
		lastReflex: ReflexRecord | null;
	}>,
): JsonObject {
	const { snapshot, memory } = input;
	const self = snapshot.self;
	const perKind = new Map<string, number>();
	const visibleBlocks = snapshot.visibleBlocks.filter((block) => {
		const count = perKind.get(block.name) ?? 0;
		perKind.set(block.name, count + 1);
		return count < PER_BLOCK_KIND;
	});
	const remembered = [
		...memory.places.map((place) => ({ name: place.name, kind: place.kind, at: place })),
		...memory.ores.map((ore) => ({ name: null, kind: ore.block, at: ore })),
	]
		.filter((entry) => entry.at.dimension === self.dimension)
		.map((entry) => ({
			name: entry.name,
			kind: entry.kind,
			position: { x: entry.at.position.x, y: entry.at.position.y, z: entry.at.position.z },
			dimension: entry.at.dimension,
			distance: round(distanceBetween(entry.at.position, self.position)),
		}))
		.toSorted((left, right) => left.distance - right.distance)
		.slice(0, PLACE_LIMIT);
	return {
		self: {
			position: roundVec(self.position),
			dimension: self.dimension,
			health: round(self.health),
			food: self.food,
			oxygen: self.oxygen,
			held: self.held,
			armor: [...self.armor],
			effects: [...self.effects],
			on_ground: self.onGround,
			in_water: self.inWater,
			in_lava: self.inLava,
			burning: self.burning,
		},
		inventory: { ...snapshot.inventory },
		world: {
			time_of_day: snapshot.world.timeOfDay,
			raining: snapshot.world.raining,
			thundering: snapshot.world.thundering,
		},
		goal:
			input.goal == null
				? null
				: {
						objective: input.goal.objective,
						targets: { ...input.goal.targets },
						waypoint: input.goal.waypoint == null ? null : { ...input.goal.waypoint },
					},
		visible_entities: snapshot.visibleEntities
			.filter((entity) => entity.distance <= SIGHT_DISTANCE)
			.slice(0, ENTITY_LIMIT)
			.map((entity) => ({
				id: entity.id,
				name: entity.name,
				kind: entity.kind,
				position: roundVec(entity.position),
				distance: round(entity.distance),
			})),
		visible_blocks: visibleBlocks.map((block) => ({
			name: block.name,
			position: { x: block.position.x, y: block.position.y, z: block.position.z },
			distance: round(block.distance),
		})),
		places: remembered,
		recent_actions: input.recentActions.slice(-RECENT_ACTION_LIMIT).map((record) => ({
			action: record.action,
			result: record.result,
			detail: record.detail,
			at: record.at,
		})),
		last_reflex: input.lastReflex == null ? null : { ...input.lastReflex },
	};
}

export function goalStatusJson(answer: GoalAnswer | null): JsonObject | null {
	return answer == null ? null : { status: answer.status, probability: round(answer.probability) };
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

function roundVec(position: Vec3): JsonObject {
	return { x: round(position.x), y: round(position.y), z: round(position.z) };
}
