import { describe, expect, it } from "vitest";

import { GOAL, memoryWith, NOW, snapshotWith } from "../testing/world-fixtures";
import { listCandidates, MAX_CANDIDATES } from "./action";

describe("listCandidates", () => {
	it("見えていて掘れるブロックだけを、種類ごとに近い順に3件まで候補にする", () => {
		const logs = [3, 1, 4, 2].map((x) => ({
			name: "oak_log",
			position: { x, y: 64, z: 0 },
			distance: x,
			harvestable: true,
		}));
		const candidates = listCandidates({
			snapshot: snapshotWith({
				visibleBlocks: [
					...logs.toSorted((left, right) => left.distance - right.distance),
					{
						name: "diamond_ore",
						position: { x: 0, y: 12, z: 0 },
						distance: 50,
						harvestable: false,
					},
				],
			}),
			memory: memoryWith(),
			goal: GOAL,
		});

		const mined = candidates.flatMap((candidate) =>
			candidate.action.type === "mine" ? [candidate.action.position.x] : [],
		);
		expect(mined).toEqual([1, 2, 3]);
		expect(candidates.find((candidate) => candidate.action.type === "mine")?.description).toBe(
			"Mine the oak_log at (1, 64, 0), 1.0 blocks away",
		);
	});

	it("目標の waypoint と、遠くの覚えている場所への移動、4方向の探索、待つを必ず含める", () => {
		const candidates = listCandidates({
			snapshot: snapshotWith(),
			memory: memoryWith({
				places: [
					{
						name: "base",
						kind: "named",
						position: { x: 40, y: 64, z: 0 },
						dimension: "overworld",
						seenAt: NOW,
					},
					{
						name: null,
						kind: "furnace",
						position: { x: 9, y: 64, z: 0 },
						dimension: "the_nether",
						seenAt: NOW,
					},
				],
			}),
			goal: { ...GOAL, waypoint: { x: 100, y: 70, z: -20 } },
		});

		expect(candidates.map((candidate) => candidate.action.type)).toEqual([
			"move_to",
			"move_to",
			"explore",
			"explore",
			"explore",
			"explore",
			"wait",
		]);
		expect(candidates[1]?.action).toEqual({
			type: "move_to",
			target: { x: 40, y: 64, z: 0 },
			label: "base",
		});
	});

	it("作業台が4ブロック以内にある時だけ、作業台の要るレシピを出し、目標のアイテムを先に並べる", () => {
		const table = { x: 2, y: 64, z: 0 };
		const snapshot = snapshotWith({
			craftable: [
				{ item: "stick", needsTable: false },
				{ item: "wooden_pickaxe", needsTable: true },
				{ item: "oak_planks", needsTable: false },
			],
		});
		const goal = { ...GOAL, targets: { oak_planks: 4 } };

		const far = listCandidates({ snapshot, memory: memoryWith(), goal });
		const near = listCandidates({
			snapshot,
			memory: memoryWith({
				places: [
					{
						name: null,
						kind: "crafting_table",
						position: table,
						dimension: "overworld",
						seenAt: NOW,
					},
				],
			}),
			goal,
		});

		const crafts = (list: typeof far) =>
			list.flatMap((candidate) => (candidate.action.type === "craft" ? [candidate.action] : []));
		expect(crafts(far)).toEqual([
			{ type: "craft", item: "oak_planks", table: null },
			{ type: "craft", item: "stick", table: null },
		]);
		expect(crafts(near)).toContainEqual({ type: "craft", item: "wooden_pickaxe", table });
	});

	it("食べるのは満腹でない時だけ、寝るのは夜にベッドがそばにある時だけ候補にする", () => {
		const bed = {
			name: null,
			kind: "bed",
			position: { x: 1, y: 64, z: 1 },
			dimension: "overworld",
			seenAt: NOW,
		};
		const day = listCandidates({
			snapshot: snapshotWith({ foods: ["bread"] }),
			memory: memoryWith({ places: [bed] }),
			goal: GOAL,
		});
		const night = listCandidates({
			snapshot: snapshotWith({
				foods: ["bread"],
				self: { food: 12 },
				world: { timeOfDay: 13_000, raining: false, thundering: false },
			}),
			memory: memoryWith({ places: [bed] }),
			goal: GOAL,
		});

		expect(day.some((candidate) => ["eat", "sleep"].includes(candidate.action.type))).toBe(false);
		expect(night.map((candidate) => candidate.action.type)).toEqual(
			expect.arrayContaining(["eat", "sleep"]),
		);
	});

	it("見えている敵には攻撃と逃げる候補、動物には攻撃だけ、落ちたアイテムには拾う候補を出す", () => {
		const candidates = listCandidates({
			snapshot: snapshotWith({
				visibleEntities: [
					{ id: 1, name: "zombie", kind: "hostile", position: { x: 5, y: 64, z: 0 }, distance: 5 },
					{ id: 2, name: "cow", kind: "passive", position: { x: 8, y: 64, z: 0 }, distance: 8 },
					{ id: 3, name: "oak_log", kind: "item", position: { x: 2, y: 64, z: 0 }, distance: 2 },
				],
			}),
			memory: memoryWith(),
			goal: GOAL,
		});

		expect(candidates.map((candidate) => candidate.action)).toEqual(
			expect.arrayContaining([
				{ type: "attack", entityId: 1 },
				{ type: "attack", entityId: 2 },
				{ type: "retreat", from: { x: 5, y: 64, z: 0 } },
				{ type: "collect", entityId: 3, position: { x: 2, y: 64, z: 0 } },
			]),
		);
		expect(candidates.filter((candidate) => candidate.action.type === "retreat")).toHaveLength(1);
	});

	it("チェストがそばにあれば、持ち物の預け入れと、最後に見た中身の取り出しを出す", () => {
		const chest = { x: 1, y: 64, z: 0 };
		const candidates = listCandidates({
			snapshot: snapshotWith({ inventory: { cobblestone: 12 } }),
			memory: memoryWith({
				places: [
					{ name: null, kind: "chest", position: chest, dimension: "overworld", seenAt: NOW },
				],
				chests: [{ position: chest, dimension: "overworld", items: { bread: 3 }, seenAt: NOW }],
			}),
			goal: GOAL,
		});

		expect(candidates.map((candidate) => candidate.action)).toEqual(
			expect.arrayContaining([
				{ type: "store", chest, item: "cobblestone", count: 12 },
				{ type: "take", chest, item: "bread", count: 3 },
			]),
		);
	});

	it("周りでできる掘る・置く操作を、置けるブロックごとに候補にする", () => {
		const candidates = listCandidates({
			snapshot: snapshotWith({
				buildingBlocks: ["dirt", "cobblestone", "oak_planks", "stone"],
				surroundings: {
					digDown: true,
					stairs: ["east"],
					tunnels: ["north", "west"],
					placeAbove: true,
					placeBelow: true,
					placeToward: ["south"],
				},
			}),
			memory: memoryWith(),
			goal: GOAL,
		});

		const actions = candidates.map((candidate) => candidate.action);
		expect(actions).toEqual(
			expect.arrayContaining([
				{ type: "dig_down" },
				{ type: "dig_stair", direction: "east" },
				{ type: "tunnel", direction: "north" },
				{ type: "tunnel", direction: "west" },
				{ type: "place_block", item: "dirt", where: "above" },
				{ type: "place_block", item: "dirt", where: "below" },
				{ type: "place_block", item: "oak_planks", where: "south" },
			]),
		);
		// 置くブロックは3種類まで。
		expect(actions.filter((action) => action.type === "place_block")).toHaveLength(9);
		expect(candidates.find((candidate) => candidate.action.type === "dig_stair")?.description).toBe(
			"Dig one step of a staircase down to the east and step onto it",
		);
	});

	it("できない掘る・置く操作は候補に出さない", () => {
		const candidates = listCandidates({
			snapshot: snapshotWith({ buildingBlocks: ["dirt"] }),
			memory: memoryWith(),
			goal: GOAL,
		});

		expect(
			candidates.some((candidate) =>
				["dig_down", "dig_stair", "tunnel", "place_block"].includes(candidate.action.type),
			),
		).toBe(false);
	});

	it(`候補を ${String(MAX_CANDIDATES)} 件までに収める`, () => {
		const candidates = listCandidates({
			snapshot: snapshotWith({
				craftable: Array.from({ length: 400 }, (_value, index) => ({
					item: `item_${String(index)}`,
					needsTable: false,
				})),
			}),
			memory: memoryWith(),
			goal: GOAL,
		});

		expect(candidates).toHaveLength(MAX_CANDIDATES);
	});
});
