import { z } from "zod";

import type { MinecraftGoal } from "./goal";
import {
	DIRECTION_STEP,
	directionSchema,
	distanceBetween,
	formatPosition,
	isNight,
	REACH_DISTANCE,
	SIGHT_DISTANCE,
	vec3Schema,
} from "./world";
import type { Direction, Vec3, WorldSnapshot } from "./world";
import type { WorldMemory } from "./world-memory";

// 決定モデルが選ぶ1手（SPEC §25.4）。経路と照準はワーカーのMineflayerに任せる。
export const minecraftActionSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("move_to"), target: vec3Schema, label: z.string() }),
	z.strictObject({ type: z.literal("explore"), direction: directionSchema, target: vec3Schema }),
	z.strictObject({ type: z.literal("mine"), block: z.string(), position: vec3Schema }),
	z.strictObject({
		type: z.literal("collect"),
		entityId: z.number().int(),
		position: vec3Schema,
	}),
	z.strictObject({ type: z.literal("craft"), item: z.string(), table: vec3Schema.nullable() }),
	z.strictObject({ type: z.literal("place"), item: z.string() }),
	z.strictObject({ type: z.literal("dig_down") }),
	z.strictObject({ type: z.literal("dig_stair"), direction: directionSchema }),
	z.strictObject({ type: z.literal("tunnel"), direction: directionSchema }),
	z.strictObject({
		type: z.literal("place_block"),
		item: z.string(),
		where: z.enum(["above", "below", ...directionSchema.options]),
	}),
	z.strictObject({
		type: z.literal("smelt"),
		furnace: vec3Schema,
		operation: z.enum(["input", "fuel", "take"]),
		item: z.string().nullable(),
	}),
	z.strictObject({
		type: z.literal("store"),
		chest: vec3Schema,
		item: z.string(),
		count: z.number().int().min(1),
	}),
	z.strictObject({
		type: z.literal("take"),
		chest: vec3Schema,
		item: z.string(),
		count: z.number().int().min(1),
	}),
	z.strictObject({ type: z.literal("equip"), item: z.string() }),
	z.strictObject({ type: z.literal("eat"), item: z.string() }),
	z.strictObject({ type: z.literal("sleep"), bed: vec3Schema }),
	z.strictObject({ type: z.literal("attack"), entityId: z.number().int() }),
	z.strictObject({ type: z.literal("retreat"), from: vec3Schema }),
	z.strictObject({ type: z.literal("wait") }),
]);
export type MinecraftAction = Readonly<z.infer<typeof minecraftActionSchema>>;
export type MinecraftActionType = MinecraftAction["type"];

export const ACTION_TIMEOUT_MS: Readonly<Record<MinecraftActionType, number>> = {
	move_to: 60_000,
	explore: 60_000,
	mine: 30_000,
	collect: 30_000,
	craft: 10_000,
	place: 10_000,
	dig_down: 15_000,
	dig_stair: 30_000,
	tunnel: 20_000,
	place_block: 10_000,
	smelt: 10_000,
	store: 10_000,
	take: 10_000,
	equip: 10_000,
	eat: 10_000,
	sleep: 10_000,
	attack: 15_000,
	retreat: 15_000,
	wait: 5_000,
};

// wait で止まる長さ。上限と同じにすると、毎回上限が先に来て失敗と数えていた。
export const WAIT_MS = 2_000;

const EXPLORE_DISTANCE = 32;
// Jev の選択肢の上限。
export const MAX_CANDIDATES = 255;
const PLACE_LIMIT = 8;
const PER_BLOCK_KIND = 3;
const ENTITY_LIMIT = 8;
const ATTACK_LIMIT = 6;
const RETREAT_LIMIT = 3;
const ITEM_LIMIT = 10;
// 置く候補にするブロックの種類の数。種類ごとに、頭上・足元・4方向の置き場所が並ぶ。
const BUILDING_KINDS = 3;

export type ActionCandidate = Readonly<{ action: MinecraftAction; description: string }>;

type CandidateInput = Readonly<{
	snapshot: WorldSnapshot;
	memory: WorldMemory;
	goal: MinecraftGoal;
}>;

// 今できる行動を、決定モデルへ見せる説明つきで列挙する。種類ごとに近い順に数を絞り、合計を上限に収める。
export function listCandidates(input: CandidateInput): readonly ActionCandidate[] {
	const { snapshot, memory, goal } = input;
	const position = snapshot.self.position;
	const dimension = snapshot.self.dimension;
	const near = (target: Vec3): boolean => distanceBetween(target, position) <= REACH_DISTANCE;
	const away = (target: Vec3): string =>
		`${formatPosition(target)}, ${distanceBetween(target, position).toFixed(1)} blocks away`;

	const places = memory.places
		.filter((place) => place.dimension === dimension)
		.toSorted(
			(left, right) =>
				distanceBetween(left.position, position) - distanceBetween(right.position, position),
		);
	const workstation = (kind: string): Vec3 | undefined =>
		places.find((place) => place.kind === kind && near(place.position))?.position;
	const table = workstation("crafting_table") ?? null;
	const furnace = workstation("furnace");
	const chest = workstation("chest");
	const bed = workstation("bed");

	const candidates: ActionCandidate[] = [];
	const push = (action: MinecraftAction, description: string): void => {
		candidates.push({ action, description });
	};

	if (goal.waypoint != null) {
		push(
			{ type: "move_to", target: goal.waypoint, label: "goal waypoint" },
			`Walk to the goal waypoint at ${away(goal.waypoint)}`,
		);
	}
	for (const place of places.filter((entry) => !near(entry.position)).slice(0, PLACE_LIMIT)) {
		const label = place.name ?? `remembered ${place.kind}`;
		push(
			{ type: "move_to", target: place.position, label },
			`Walk to ${label} at ${away(place.position)}`,
		);
	}
	for (const direction of directionSchema.options) {
		const target = exploreTarget(position, direction);
		push(
			{ type: "explore", direction, target },
			`Explore ${String(EXPLORE_DISTANCE)} blocks to the ${direction}`,
		);
	}

	const perKind = new Map<string, number>();
	for (const block of snapshot.visibleBlocks) {
		if (!block.harvestable) continue;
		const count = perKind.get(block.name) ?? 0;
		if (count >= PER_BLOCK_KIND) continue;
		perKind.set(block.name, count + 1);
		push(
			{ type: "mine", block: block.name, position: block.position },
			`Mine the ${block.name} at ${formatPosition(block.position)}, ${block.distance.toFixed(1)} blocks away`,
		);
	}

	const entities = snapshot.visibleEntities.filter((entity) => entity.distance <= SIGHT_DISTANCE);
	for (const item of entities.filter((entity) => entity.kind === "item").slice(0, ENTITY_LIMIT)) {
		push(
			{ type: "collect", entityId: item.id, position: item.position },
			`Pick up the dropped ${item.name} at ${away(item.position)}`,
		);
	}

	const targets = new Set(Object.keys(goal.targets));
	const craftable = snapshot.craftable
		.filter((recipe) => !recipe.needsTable || table != null)
		.toSorted((left, right) => Number(targets.has(right.item)) - Number(targets.has(left.item)));
	for (const recipe of craftable) {
		const at = recipe.needsTable && table != null ? ` at the crafting table` : "";
		push(
			{ type: "craft", item: recipe.item, table: recipe.needsTable ? table : null },
			`Craft ${recipe.item}${at}`,
		);
	}
	for (const item of snapshot.placeable) {
		push({ type: "place", item }, `Place a ${item} next to you`);
	}

	const around = snapshot.surroundings;
	if (around.digDown)
		push({ type: "dig_down" }, "Dig the block under your feet and drop down one block");
	for (const direction of around.stairs) {
		push(
			{ type: "dig_stair", direction },
			`Dig one step of a staircase down to the ${direction} and step onto it`,
		);
	}
	for (const direction of around.tunnels) {
		push(
			{ type: "tunnel", direction },
			`Dig the two blocks in front of you to the ${direction} and step forward`,
		);
	}
	for (const item of snapshot.buildingBlocks.slice(0, BUILDING_KINDS)) {
		if (around.placeAbove) {
			push(
				{ type: "place_block", item, where: "above" },
				`Place ${item} above your head to close the opening`,
			);
		}
		if (around.placeBelow) {
			push(
				{ type: "place_block", item, where: "below" },
				`Jump and place ${item} under your feet to rise one block`,
			);
		}
		for (const direction of around.placeToward) {
			push(
				{ type: "place_block", item, where: direction },
				`Place ${item} next to you to the ${direction}`,
			);
		}
	}

	if (furnace !== undefined) {
		for (const item of snapshot.smeltable.slice(0, ITEM_LIMIT)) {
			push(
				{ type: "smelt", furnace, operation: "input", item },
				`Put ${item} into the furnace to smelt`,
			);
		}
		for (const item of snapshot.fuels.slice(0, ITEM_LIMIT)) {
			push(
				{ type: "smelt", furnace, operation: "fuel", item },
				`Put ${item} into the furnace as fuel`,
			);
		}
		push(
			{ type: "smelt", furnace, operation: "take", item: null },
			"Take the finished items out of the furnace",
		);
	}
	if (chest !== undefined) {
		for (const [item, count] of Object.entries(snapshot.inventory).slice(0, ITEM_LIMIT)) {
			push(
				{ type: "store", chest, item, count },
				`Store all ${String(count)} ${item} in the chest`,
			);
		}
		const stored = memory.chests.find(
			(entry) => entry.dimension === dimension && distanceBetween(entry.position, chest) === 0,
		);
		for (const [item, count] of Object.entries(stored?.items ?? {}).slice(0, ITEM_LIMIT)) {
			push(
				{ type: "take", chest, item, count },
				`Take ${String(count)} ${item} from the chest (as last seen)`,
			);
		}
	}

	for (const item of snapshot.equippable.slice(0, ITEM_LIMIT)) {
		push({ type: "equip", item }, `Equip ${item}`);
	}
	if (snapshot.self.food < 20) {
		for (const item of snapshot.foods.slice(0, ITEM_LIMIT)) {
			push({ type: "eat", item }, `Eat ${item}`);
		}
	}
	if (bed !== undefined && isNight(snapshot.world.timeOfDay)) {
		push({ type: "sleep", bed }, "Sleep in the bed until morning");
	}

	const creatures = entities.filter(
		(entity) => entity.kind === "hostile" || entity.kind === "passive",
	);
	for (const creature of creatures.slice(0, ATTACK_LIMIT)) {
		push(
			{ type: "attack", entityId: creature.id },
			`Attack the ${creature.kind} ${creature.name} at ${away(creature.position)}`,
		);
	}
	for (const hostile of creatures
		.filter((entity) => entity.kind === "hostile")
		.slice(0, RETREAT_LIMIT)) {
		push(
			{ type: "retreat", from: hostile.position },
			`Run away from the ${hostile.name} at ${away(hostile.position)}`,
		);
	}
	push({ type: "wait" }, `Wait for ${String(WAIT_MS / 1_000)} seconds`);

	return candidates.slice(0, MAX_CANDIDATES);
}

function exploreTarget(position: Vec3, direction: Direction): Vec3 {
	const step = DIRECTION_STEP[direction];
	return {
		x: Math.floor(position.x) + step.x * EXPLORE_DISTANCE,
		y: Math.floor(position.y),
		z: Math.floor(position.z) + step.z * EXPLORE_DISTANCE,
	};
}

export function describeAction(action: MinecraftAction): string {
	switch (action.type) {
		case "move_to":
			return `move_to ${action.label} ${formatPosition(action.target)}`;
		case "explore":
			return `explore ${action.direction}`;
		case "mine":
			return `mine ${action.block} ${formatPosition(action.position)}`;
		case "collect":
			return `collect ${formatPosition(action.position)}`;
		case "craft":
			return `craft ${action.item}`;
		case "place":
			return `place ${action.item}`;
		case "dig_down":
			return "dig_down";
		case "dig_stair":
		case "tunnel":
			return `${action.type} ${action.direction}`;
		case "place_block":
			return `place_block ${action.item} ${action.where}`;
		case "smelt":
			return `smelt ${action.operation}${action.item == null ? "" : ` ${action.item}`}`;
		case "store":
		case "take":
			return `${action.type} ${String(action.count)} ${action.item}`;
		case "equip":
		case "eat":
			return `${action.type} ${action.item}`;
		case "sleep":
			return "sleep";
		case "attack":
			return `attack ${String(action.entityId)}`;
		case "retreat":
			return `retreat from ${formatPosition(action.from)}`;
		case "wait":
			return "wait";
		default: {
			const unknownAction: never = action;
			throw new Error(`Unknown Minecraft action: ${JSON.stringify(unknownAction)}`);
		}
	}
}
