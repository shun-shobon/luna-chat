import { defineConfig } from "tsdown";

export default defineConfig({
	// Mineflayer はワーカースレッドで動かすため、ワーカーの入口を別のファイル（dist/minecraft-worker.mjs）に出す。
	entry: {
		index: "./src/index.ts",
		"minecraft-worker": "./src/modules/minecraft/adapters/mineflayer-worker.ts",
	},
	format: "esm",
	outDir: "dist",
	platform: "node",
});
