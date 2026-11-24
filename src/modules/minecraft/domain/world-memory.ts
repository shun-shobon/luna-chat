import { z } from "zod";

import {
	distanceBetween,
	isOreBlock,
	placeKindOf,
	samePosition,
	SIGHT_DISTANCE,
	vec3Schema,
} from "./world";
import type { Vec3, WorldSnapshot } from "./world";

const isoDateTime = z.iso.datetime({ offset: true });
const DEATH_LIMIT = 20;
// 観測ごとにワーカーへ確かめさせる、記憶した位置の数。
const VERIFY_LIMIT = 64;

export const worldMemorySchema = z.strictObject({
	version: z.literal(1),
	places: z.array(
		z.strictObject({
			name: z.string().nullable(),
			kind: z.string(),
			position: vec3Schema,
			dimension: z.string(),
			seenAt: isoDateTime,
		}),
	),
	ores: z.array(
		z.strictObject({
			block: z.string(),
			position: vec3Schema,
			dimension: z.string(),
			seenAt: isoDateTime,
		}),
	),
	chests: z.array(
		z.strictObject({
			position: vec3Schema,
			dimension: z.string(),
			items: z.record(z.string(), z.number().int().min(1)),
			seenAt: isoDateTime,
		}),
	),
	deaths: z.array(
		z.strictObject({
			position: vec3Schema,
			dimension: z.string(),
			at: isoDateTime,
			message: z.string(),
			lostItems: z.record(z.string(), z.number().int().min(1)),
		}),
	),
});
export type WorldMemory = Readonly<z.infer<typeof worldMemorySchema>>;
export type RememberedPlace = WorldMemory["places"][number];
export type DeathRecord = WorldMemory["deaths"][number];

export const EMPTY_WORLD_MEMORY: WorldMemory = {
	version: 1,
	places: [],
	ores: [],
	chests: [],
	deaths: [],
};

// 観測を受けて記憶を更新する。見えた作業台・鉱石などを足し、記憶した位置が見えて別のものに
// 変わっていたら消す（docs/minecraft.md の「ワールドの記憶」）。名付けた場所は、ブロックとは関係なく残す。
export function rememberSnapshot(
	memory: WorldMemory,
	snapshot: WorldSnapshot,
	seenAt: string,
): WorldMemory {
	const dimension = snapshot.self.dimension;
	const blockAt = (position: Vec3): string | undefined =>
		snapshot.verified.find((entry) => samePosition(entry.position, position))?.block;
	const keepPlace = (place: RememberedPlace): boolean => {
		if (place.name != null || place.dimension !== dimension) return true;
		const block = blockAt(place.position);
		return block === undefined || placeKindOf(block) === place.kind;
	};
	const keepOre = (ore: WorldMemory["ores"][number]): boolean => {
		if (ore.dimension !== dimension) return true;
		const block = blockAt(ore.position);
		return block === undefined || block === ore.block;
	};
	let places = memory.places.filter(keepPlace);
	let ores = memory.ores.filter(keepOre);
	for (const block of snapshot.visibleBlocks) {
		const kind = placeKindOf(block.name);
		if (kind !== undefined) {
			places = upsertBy(
				places,
				(place) =>
					place.name == null &&
					place.dimension === dimension &&
					samePosition(place.position, block.position),
				{ name: null, kind, position: block.position, dimension, seenAt },
			);
		}
		if (isOreBlock(block.name)) {
			ores = upsertBy(
				ores,
				(ore) => ore.dimension === dimension && samePosition(ore.position, block.position),
				{ block: block.name, position: block.position, dimension, seenAt },
			);
		}
	}
	return { ...memory, places, ores };
}

export function nameRememberedPlace(
	memory: WorldMemory,
	input: Readonly<{ name: string; position: Vec3; dimension: string; seenAt: string }>,
): WorldMemory {
	return {
		...memory,
		places: upsertBy(memory.places, (place) => place.name === input.name, {
			name: input.name,
			kind: "named",
			position: input.position,
			dimension: input.dimension,
			seenAt: input.seenAt,
		}),
	};
}

export function rememberChest(
	memory: WorldMemory,
	input: Readonly<{
		position: Vec3;
		dimension: string;
		items: Readonly<Record<string, number>>;
		seenAt: string;
	}>,
): WorldMemory {
	return {
		...memory,
		chests: upsertBy(
			memory.chests,
			(chest) =>
				chest.dimension === input.dimension && samePosition(chest.position, input.position),
			{ ...input, items: { ...input.items } },
		),
	};
}

export function rememberDeath(memory: WorldMemory, death: DeathRecord): WorldMemory {
	return { ...memory, deaths: [...memory.deaths, death].slice(-DEATH_LIMIT) };
}

export function findNamedPlace(memory: WorldMemory, name: string): RememberedPlace | undefined {
	return memory.places.find((place) => place.name === name);
}

// 観測のたびにワーカーへ確かめさせる、記憶した位置。見える距離にあるものだけを近い順に渡す。
export function positionsToVerify(
	memory: WorldMemory,
	position: Vec3,
	dimension: string,
): readonly Vec3[] {
	return [...memory.places.filter((place) => place.name == null), ...memory.ores]
		.filter((entry) => entry.dimension === dimension)
		.map((entry) => entry.position)
		.filter((candidate) => distanceBetween(candidate, position) <= SIGHT_DISTANCE)
		.toSorted((left, right) => distanceBetween(left, position) - distanceBetween(right, position))
		.slice(0, VERIFY_LIMIT);
}

function upsertBy<Item>(
	items: readonly Item[],
	matches: (item: Item) => boolean,
	next: Item,
): Item[] {
	return [...items.filter((item) => !matches(item)), next];
}
