import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { IntentFileStore } from "./intent-file-store";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

async function setup(toml?: string) {
	const directory = await mkdtemp(join(tmpdir(), "luna-intents-"));
	directories.push(directory);
	const intentsPath = join(directory, "intents.toml");
	if (toml !== undefined) await writeFile(intentsPath, toml);
	return {
		store: new IntentFileStore(intentsPath, join(directory, "state", "intents.json")),
		directory,
	};
}

describe("IntentFileStore", () => {
	it("ファイルがなければ予定も状態も空にする", async () => {
		const { store } = await setup();

		expect(store.readIntents()).toEqual([]);
		expect(store.readStates()).toEqual({});
	});

	it("省略した cooldown_hours と max_fires を仕様の既定値で補う", async () => {
		const { store } = await setup(`
[[intents]]
id = "ask-trip"
keywords = ["旅行"]
action = "感想を聞く"
expires_at = "2026-12-01T00:00:00+09:00"
`);

		expect(store.readIntents()).toEqual([
			{
				id: "ask-trip",
				keywords: ["旅行"],
				action: "感想を聞く",
				expiresAt: new Date("2026-11-30T15:00:00.000Z"),
				cooldownHours: 24,
				maxFires: 3,
			},
		]);
	});

	it.each([
		[
			"idの重複",
			`[[intents]]\nid="a"\nkeywords=["x"]\naction="y"\nexpires_at="2026-12-01T00:00:00Z"\n[[intents]]\nid="a"\nkeywords=["x"]\naction="y"\nexpires_at="2026-12-01T00:00:00Z"`,
		],
		[
			"キーワードなし",
			`[[intents]]\nid="a"\nkeywords=[]\naction="y"\nexpires_at="2026-12-01T00:00:00Z"`,
		],
		["期限なし", `[[intents]]\nid="a"\nkeywords=["x"]\naction="y"`],
		["TOMLの誤り", "[[intents]"],
	])("%sは不正として例外にする", async (_label, toml) => {
		const { store } = await setup(toml);

		expect(() => store.readIntents()).toThrow(Error);
	});

	it("状態を書いて読み戻せる", async () => {
		const { store, directory } = await setup();
		const states = { a: { fires: 1, lastFiredAt: "2026-11-14T12:00:00.000Z" } };

		store.writeStates(states);

		expect(store.readStates()).toEqual(states);
		expect(JSON.parse(await readFile(join(directory, "state", "intents.json"), "utf8"))).toEqual(
			states,
		);
	});
});
