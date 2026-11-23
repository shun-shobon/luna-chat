import type { WorldMemory } from "../domain/world-memory";

export interface WorldMemoryStorePort {
	// ファイルがなければ空の記憶を返す。読めない・スキーマに合わなければ例外にする。
	load(): Promise<WorldMemory>;
	save(memory: WorldMemory): Promise<void>;
}
