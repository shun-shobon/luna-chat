import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { EMPTY_WORLD_MEMORY } from "../domain/world-memory";
import { JsonWorldMemoryStore } from "./json-world-memory-store";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
	);
});

async function directory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "luna-minecraft-memory-"));
	directories.push(path);
	return path;
}

describe("JsonWorldMemoryStore", () => {
	it("ファイルがなければ空の記憶を返し、保存したものを読み直せる", async () => {
		const path = join(await directory(), "trial-1", "memory.json");
		const store = new JsonWorldMemoryStore(path);
		const memory = {
			...EMPTY_WORLD_MEMORY,
			places: [
				{
					name: "base",
					kind: "named",
					position: { x: 1, y: 64, z: 2 },
					dimension: "overworld",
					seenAt: "2026-11-23T10:00:00.000Z",
				},
			],
		};

		await expect(store.load()).resolves.toEqual(EMPTY_WORLD_MEMORY);
		await store.save(memory);

		await expect(store.load()).resolves.toEqual(memory);
		expect(await readFile(path, "utf8")).toContain('"name": "base"');
	});

	it("スキーマに合わないファイルは例外にする", async () => {
		const path = join(await directory(), "memory.json");
		await writeFile(path, JSON.stringify({ version: 1, places: "broken" }));

		await expect(new JsonWorldMemoryStore(path).load()).rejects.toBeInstanceOf(z.ZodError);
	});
});
