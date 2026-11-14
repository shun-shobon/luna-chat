import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRecordingLogger } from "../../observability/testing/recording-logger";
import { WatchConfigFile } from "./watch-config-file";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

async function setup(toml?: string) {
	const directory = await mkdtemp(join(tmpdir(), "luna-home-assistant-"));
	directories.push(directory);
	const path = join(directory, "home-assistant.toml");
	if (toml !== undefined) await writeFile(path, toml);
	const logger = createRecordingLogger();
	return { file: new WatchConfigFile(path, logger), logger, path };
}

describe("WatchConfigFile", () => {
	it("ファイルがなければmissingにする", async () => {
		const { file } = await setup();

		expect(file.read()).toEqual({ status: "missing" });
	});

	it("省略した項目を仕様の既定値で補う", async () => {
		const { file } = await setup('watch = ["climate.*"]\n');

		expect(file.read()).toEqual({
			status: "valid",
			config: { watch: ["climate.*"], ignore: [], cooldownSeconds: 30 },
		});
	});

	it("指定したignoreとcooldown_secondsを読む", async () => {
		const { file } = await setup(
			'watch = ["binary_sensor.*"]\nignore = ["*_battery"]\ncooldown_seconds = 0\n',
		);

		expect(file.read()).toEqual({
			status: "valid",
			config: { watch: ["binary_sensor.*"], ignore: ["*_battery"], cooldownSeconds: 0 },
		});
	});

	it.each([
		["未知のキー", 'watch = ["a.b"]\nextra = 1\n'],
		["空白だけのパターン", 'watch = ["  "]\n'],
		["負のcooldown", "cooldown_seconds = -1\n"],
		["TOMLの構文エラー", "watch = [\n"],
	])("%sは不正として扱い、同じ更新時刻ではエラーログを1回だけ残す", async (_label, toml) => {
		const { file, logger } = await setup(toml);

		const first = file.read();
		const second = file.read();

		expect(first.status).toBe("invalid");
		expect(second).toBe(first);
		expect(
			logger.entries.filter((entry) => entry.event === "home_assistant.watch_config_invalid"),
		).toHaveLength(1);
	});

	it("更新時刻が変わったら読み直す", async () => {
		const { file, path } = await setup('watch = ["light.*"]\n');
		expect(file.read()).toMatchObject({ config: { watch: ["light.*"] } });

		await writeFile(path, 'watch = ["switch.*"]\n');
		const later = new Date(Date.now() + 10_000);
		await utimes(path, later, later);

		expect(file.read()).toMatchObject({ config: { watch: ["switch.*"] } });
	});

	it("消されたらmissingに戻る", async () => {
		const { file, path } = await setup('watch = ["light.*"]\n');
		file.read();

		await rm(path);

		expect(file.read()).toEqual({ status: "missing" });
	});
});
