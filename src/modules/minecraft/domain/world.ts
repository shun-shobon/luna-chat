import { z } from "zod";

export const vec3Schema = z.strictObject({ x: z.number(), y: z.number(), z: z.number() });
export type Vec3 = Readonly<z.infer<typeof vec3Schema>>;

const entityKindSchema = z.enum(["hostile", "passive", "player", "item", "other"]);

export const directionSchema = z.enum(["north", "south", "east", "west"]);
export type Direction = z.infer<typeof directionSchema>;

// 東西南北の1マスの向き。北は -z、東は +x。
export const DIRECTION_STEP: Readonly<Record<Direction, Readonly<{ x: number; z: number }>>> = {
	north: { x: 0, z: -1 },
	south: { x: 0, z: 1 },
	east: { x: 1, z: 0 },
	west: { x: -1, z: 0 },
};
export type EntityKind = z.infer<typeof entityKindSchema>;

// 観測の対象にする距離（ブロック）。見える判定もこの距離までとする。
export const SIGHT_DISTANCE = 32;
// 作業台・かまど・チェスト・ベッドを使える距離（ブロック）。
export const REACH_DISTANCE = 4;

// ワーカースレッドが読んだ、その時点のワールドの素材。観測と行動の候補はここから作る。
// 見えるものだけを入れる（SPEC §25.3）。並びは近い順。
export const worldSnapshotSchema = z.strictObject({
	self: z.strictObject({
		position: vec3Schema,
		dimension: z.string(),
		health: z.number(),
		food: z.number(),
		oxygen: z.number(),
		held: z.string().nullable(),
		armor: z.array(z.string()),
		effects: z.array(z.string()),
		onGround: z.boolean(),
		inWater: z.boolean(),
		inLava: z.boolean(),
		burning: z.boolean(),
	}),
	inventory: z.record(z.string(), z.number().int().min(1)),
	world: z.strictObject({
		timeOfDay: z.number().int().min(0),
		raining: z.boolean(),
		thundering: z.boolean(),
	}),
	visibleEntities: z.array(
		z.strictObject({
			id: z.number().int(),
			name: z.string(),
			kind: entityKindSchema,
			position: vec3Schema,
			distance: z.number().min(0),
		}),
	),
	visibleBlocks: z.array(
		z.strictObject({
			name: z.string(),
			position: vec3Schema,
			distance: z.number().min(0),
			// 今の持ち物で掘ってアイテムを落とせるか。
			harvestable: z.boolean(),
		}),
	),
	// 記憶した位置を確かめた結果。見えた位置だけを返し、block はそこにある今のブロック。
	verified: z.array(z.strictObject({ position: vec3Schema, block: z.string() })),
	craftable: z.array(z.strictObject({ item: z.string(), needsTable: z.boolean() })),
	foods: z.array(z.string()),
	fuels: z.array(z.string()),
	smeltable: z.array(z.string()),
	equippable: z.array(z.string()),
	placeable: z.array(z.string()),
	// 土・丸石・板材など、足場や壁に置けるブロック。
	buildingBlocks: z.array(z.string()),
	// 触れている周りのブロックへの操作のうち、今できるもの。ワーカーが足元・頭上・隣のブロックを見て決める。
	surroundings: z.strictObject({
		digDown: z.boolean(),
		stairs: z.array(directionSchema),
		tunnels: z.array(directionSchema),
		placeAbove: z.boolean(),
		placeBelow: z.boolean(),
		placeToward: z.array(directionSchema),
	}),
	reflexActive: z.boolean(),
});
export type WorldSnapshot = Readonly<z.infer<typeof worldSnapshotSchema>>;

export function distanceBetween(left: Vec3, right: Vec3): number {
	return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

export function blockPosition(position: Vec3): Vec3 {
	return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
}

export function samePosition(left: Vec3, right: Vec3): boolean {
	return left.x === right.x && left.y === right.y && left.z === right.z;
}

export function formatPosition(position: Vec3): string {
	return `(${[position.x, position.y, position.z].map((value) => String(Math.round(value))).join(", ")})`;
}

const WORKSTATION_KINDS = ["crafting_table", "furnace", "chest"] as const;

// 場所として記憶するブロックの種類。ベッドは色ごとに名前が違うため bed にまとめる。
export function placeKindOf(blockName: string): string | undefined {
	if (blockName.endsWith("_bed")) return "bed";
	return WORKSTATION_KINDS.find((kind) => kind === blockName);
}

export function isOreBlock(blockName: string): boolean {
	return blockName.endsWith("_ore") || blockName === "ancient_debris";
}

// 観測の visible_blocks に載せるブロック（SPEC §25.3）。目標の targets を落とすブロックは別に足す。
export function isInterestingBlock(blockName: string): boolean {
	return (
		blockName.endsWith("_log") ||
		isOreBlock(blockName) ||
		placeKindOf(blockName) !== undefined ||
		["stone", "sand", "gravel", "water", "lava"].includes(blockName)
	);
}

// 夜（寝られる時間）は Minecraft の時刻で 12542〜23459。
export function isNight(timeOfDay: number): boolean {
	const time = timeOfDay % 24_000;
	return time >= 12_542 && time <= 23_459;
}
