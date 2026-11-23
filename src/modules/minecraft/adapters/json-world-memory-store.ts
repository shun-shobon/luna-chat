import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { writeFileAtomic } from "../../../shared/atomic-file";
import { EMPTY_WORLD_MEMORY, worldMemorySchema } from "../domain/world-memory";
import type { WorldMemory } from "../domain/world-memory";
import type { WorldMemoryStorePort } from "../ports/world-memory-store-port";

// LUNA_HOME/minecraft/<world>/memory.json に、ワールドごとの記憶を置く（SPEC §25.8）。
export class JsonWorldMemoryStore implements WorldMemoryStorePort {
	constructor(private readonly path: string) {}

	async load(): Promise<WorldMemory> {
		let source: string;
		try {
			source = await readFile(this.path, "utf8");
		} catch (error: unknown) {
			if (isMissingFile(error)) return EMPTY_WORLD_MEMORY;
			throw error;
		}
		return worldMemorySchema.parse(JSON.parse(source));
	}

	async save(memory: WorldMemory): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await writeFileAtomic(this.path, `${JSON.stringify(memory, null, "\t")}\n`, { mode: 0o600 });
	}
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
