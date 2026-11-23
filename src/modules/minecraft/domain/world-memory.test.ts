import { describe, expect, it } from "vitest";

import { memoryWith, NOW, snapshotWith } from "../testing/world-fixtures";
import {
	nameRememberedPlace,
	positionsToVerify,
	rememberChest,
	rememberDeath,
	rememberSnapshot,
} from "./world-memory";

const LATER = "2026-11-23T10:05:00.000Z";
const table = { x: 3, y: 64, z: 0 };

describe("rememberSnapshot", () => {
	it("見えた作業台と鉱石を記憶し、同じ位置は新しい時刻で置き換える", () => {
		const snapshot = snapshotWith({
			visibleBlocks: [
				{ name: "crafting_table", position: table, distance: 3, harvestable: true },
				{ name: "iron_ore", position: { x: 0, y: 40, z: 5 }, distance: 24, harvestable: false },
				{ name: "oak_log", position: { x: 1, y: 64, z: 1 }, distance: 1, harvestable: true },
			],
		});

		const first = rememberSnapshot(memoryWith(), snapshot, NOW);
		const second = rememberSnapshot(first, snapshot, LATER);

		expect(second.places).toEqual([
			{
				name: null,
				kind: "crafting_table",
				position: table,
				dimension: "overworld",
				seenAt: LATER,
			},
		]);
		expect(second.ores).toEqual([
			{ block: "iron_ore", position: { x: 0, y: 40, z: 5 }, dimension: "overworld", seenAt: LATER },
		]);
	});

	it("記憶した位置が見えて別のブロックになっていたら消し、名付けた場所は残す", () => {
		const memory = memoryWith({
			places: [
				{
					name: null,
					kind: "crafting_table",
					position: table,
					dimension: "overworld",
					seenAt: NOW,
				},
				{ name: "base", kind: "named", position: table, dimension: "overworld", seenAt: NOW },
			],
			ores: [
				{ block: "coal_ore", position: { x: 5, y: 60, z: 5 }, dimension: "overworld", seenAt: NOW },
			],
		});

		const updated = rememberSnapshot(
			memory,
			snapshotWith({
				verified: [
					{ position: table, block: "air" },
					{ position: { x: 5, y: 60, z: 5 }, block: "stone" },
				],
			}),
			LATER,
		);

		expect(updated.places.map((place) => place.name)).toEqual(["base"]);
		expect(updated.ores).toEqual([]);
	});

	it("別の次元の記憶は確かめずに残す", () => {
		const memory = memoryWith({
			places: [
				{ name: null, kind: "furnace", position: table, dimension: "the_nether", seenAt: NOW },
			],
		});

		const updated = rememberSnapshot(
			memory,
			snapshotWith({ verified: [{ position: table, block: "air" }] }),
			LATER,
		);

		expect(updated.places).toHaveLength(1);
	});
});

describe("ワールドの記憶の更新", () => {
	it("名付けた場所は同じ名前で置き換える", () => {
		const first = nameRememberedPlace(memoryWith(), {
			name: "base",
			position: table,
			dimension: "overworld",
			seenAt: NOW,
		});
		const moved = nameRememberedPlace(first, {
			name: "base",
			position: { x: 9, y: 70, z: 9 },
			dimension: "overworld",
			seenAt: LATER,
		});

		expect(moved.places).toEqual([
			{
				name: "base",
				kind: "named",
				position: { x: 9, y: 70, z: 9 },
				dimension: "overworld",
				seenAt: LATER,
			},
		]);
	});

	it("チェストは位置ごとに最後に見た中身を持つ", () => {
		const first = rememberChest(memoryWith(), {
			position: table,
			dimension: "overworld",
			items: { bread: 2 },
			seenAt: NOW,
		});
		const updated = rememberChest(first, {
			position: table,
			dimension: "overworld",
			items: { bread: 5 },
			seenAt: LATER,
		});

		expect(updated.chests).toEqual([
			{ position: table, dimension: "overworld", items: { bread: 5 }, seenAt: LATER },
		]);
	});

	it("死亡は直近20件だけを持つ", () => {
		let memory = memoryWith();
		for (let index = 0; index < 25; index += 1) {
			memory = rememberDeath(memory, {
				position: { x: index, y: 64, z: 0 },
				dimension: "overworld",
				at: NOW,
				message: `death ${String(index)}`,
				lostItems: {},
			});
		}

		expect(memory.deaths).toHaveLength(20);
		expect(memory.deaths[0]?.message).toBe("death 5");
	});
});

describe("positionsToVerify", () => {
	it("同じ次元で見える距離にある、名前のない場所と鉱石を近い順に返す", () => {
		const memory = memoryWith({
			places: [
				{
					name: null,
					kind: "chest",
					position: { x: 20, y: 64, z: 0 },
					dimension: "overworld",
					seenAt: NOW,
				},
				{
					name: "base",
					kind: "named",
					position: { x: 1, y: 64, z: 0 },
					dimension: "overworld",
					seenAt: NOW,
				},
				{
					name: null,
					kind: "furnace",
					position: { x: 2, y: 64, z: 0 },
					dimension: "the_nether",
					seenAt: NOW,
				},
			],
			ores: [
				{ block: "iron_ore", position: { x: 5, y: 60, z: 0 }, dimension: "overworld", seenAt: NOW },
				{
					block: "gold_ore",
					position: { x: 90, y: 20, z: 0 },
					dimension: "overworld",
					seenAt: NOW,
				},
			],
		});

		expect(positionsToVerify(memory, { x: 0, y: 64, z: 0 }, "overworld")).toEqual([
			{ x: 5, y: 60, z: 0 },
			{ x: 20, y: 64, z: 0 },
		]);
	});
});
