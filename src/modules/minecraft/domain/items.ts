// 行動の候補に使うアイテムの分類。版ごとのデータに頼らず名前で決め、作れる・使えるかはワーカーが確かめる。

const WOODS = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry"];
const TOOL_MATERIALS = ["wooden", "stone", "iron", "golden", "diamond"];
const TOOL_KINDS = ["pickaxe", "axe", "shovel", "sword", "hoe"];
const ARMOR_KINDS = ["helmet", "chestplate", "leggings", "boots"];

// 作れるかを毎回確かめるアイテム。目標の targets にあるものも足す。
export const CRAFT_CANDIDATES: readonly string[] = [
	...WOODS.map((wood) => `${wood}_planks`),
	"stick",
	"crafting_table",
	"furnace",
	"chest",
	"torch",
	"bucket",
	"shield",
	"bread",
	"white_bed",
	...TOOL_MATERIALS.flatMap((material) => TOOL_KINDS.map((kind) => `${material}_${kind}`)),
	...["iron", "diamond"].flatMap((material) => ARMOR_KINDS.map((kind) => `${material}_${kind}`)),
];

const SMELTABLE: ReadonlySet<string> = new Set([
	"raw_iron",
	"raw_gold",
	"raw_copper",
	"sand",
	"cobblestone",
	"beef",
	"porkchop",
	"chicken",
	"mutton",
	"rabbit",
	"cod",
	"salmon",
	"potato",
	"kelp",
]);

const FUELS: ReadonlySet<string> = new Set([
	"coal",
	"charcoal",
	"coal_block",
	"blaze_rod",
	"stick",
]);

export function isSmeltable(item: string): boolean {
	return SMELTABLE.has(item) || item.endsWith("_log");
}

export function isFuel(item: string): boolean {
	return FUELS.has(item) || item.endsWith("_planks") || item.endsWith("_log");
}

export function isEquippable(item: string): boolean {
	return (
		item === "shield" ||
		TOOL_KINDS.some((kind) => item.endsWith(`_${kind}`)) ||
		ARMOR_KINDS.some((kind) => item.endsWith(`_${kind}`))
	);
}

export function isPlaceable(item: string): boolean {
	return ["crafting_table", "furnace", "chest", "torch"].includes(item) || item.endsWith("_bed");
}

const BUILDING_BLOCKS: ReadonlySet<string> = new Set([
	"dirt",
	"cobblestone",
	"cobbled_deepslate",
	"stone",
	"netherrack",
	"sandstone",
]);

// 足場や壁として置くブロック。落ちる砂・砂利は外す。
export function isBuildingBlock(item: string): boolean {
	return BUILDING_BLOCKS.has(item) || item.endsWith("_planks");
}

// 経路探索が足場に使ってよいブロック（docs/minecraft.md の「1手の判断」）。
export const SCAFFOLDING_BLOCKS: readonly string[] = ["dirt", "cobblestone"];
