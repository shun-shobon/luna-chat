import type { MinecraftGoal } from "../domain/goal";
import type { WorldSnapshot } from "../domain/world";
import { EMPTY_WORLD_MEMORY } from "../domain/world-memory";
import type { WorldMemory } from "../domain/world-memory";

export const NOW = "2026-11-23T10:00:00.000Z";

type SnapshotOverrides = Partial<Omit<WorldSnapshot, "self">> & {
	self?: Partial<WorldSnapshot["self"]>;
};

export function snapshotWith(overrides: SnapshotOverrides = {}): WorldSnapshot {
	const { self, ...rest } = overrides;
	return {
		self: {
			position: { x: 0.5, y: 64, z: 0.5 },
			dimension: "overworld",
			health: 20,
			food: 20,
			oxygen: 20,
			held: null,
			armor: [],
			effects: [],
			onGround: true,
			inWater: false,
			inLava: false,
			burning: false,
			...self,
		},
		inventory: {},
		world: { timeOfDay: 1000, raining: false, thundering: false },
		visibleEntities: [],
		visibleBlocks: [],
		verified: [],
		craftable: [],
		foods: [],
		fuels: [],
		smeltable: [],
		equippable: [],
		placeable: [],
		buildingBlocks: [],
		surroundings: {
			digDown: false,
			stairs: [],
			tunnels: [],
			placeAbove: false,
			placeBelow: false,
			placeToward: [],
		},
		reflexActive: false,
		...rest,
	};
}

export function memoryWith(overrides: Partial<WorldMemory> = {}): WorldMemory {
	return { ...EMPTY_WORLD_MEMORY, ...overrides };
}

export const GOAL: MinecraftGoal = {
	objective: "Collect 4 oak logs",
	targets: { oak_log: 4 },
	waypoint: null,
};
