import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findSkillNames, SkillUsageStore } from "./skill-usage-store";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

describe("findSkillNames", () => {
	it("read のパスやシェルのコマンドに出てきた SKILL.md から名前を重複なく拾う", () => {
		expect(
			findSkillNames({
				cmd: "cat .agents/skills/transit-route/SKILL.md; sed -n 1p /w/.agents/skills/cron/SKILL.md .agents/skills/cron/SKILL.md",
			}),
		).toEqual(["transit-route", "cron"]);
		expect(findSkillNames({ path: ".agents/skills/cron/scripts/a.py" })).toEqual([]);
	});
});

describe("SkillUsageStore", () => {
	it("並行した記録も取りこぼさず、回数と最後の時刻を残す", async () => {
		const directory = await mkdtemp(join(tmpdir(), "luna-skill-usage-"));
		directories.push(directory);
		const filePath = join(directory, "state", "skill-usage.json");
		const store = new SkillUsageStore(filePath);

		await Promise.all([
			store.record(["cron"], new Date("2026-11-14T00:00:00.000Z")),
			store.record(["cron", "transit-route"], new Date("2026-11-14T01:00:00.000Z")),
			store.record([], new Date("2026-11-14T02:00:00.000Z")),
		]);

		expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
			cron: { lastUsedAt: "2026-11-14T01:00:00.000Z", uses: 2 },
			"transit-route": { lastUsedAt: "2026-11-14T01:00:00.000Z", uses: 1 },
		});
	});

	it("壊れたファイルは上書きせずに失敗する", async () => {
		const directory = await mkdtemp(join(tmpdir(), "luna-skill-usage-"));
		directories.push(directory);
		const filePath = join(directory, "skill-usage.json");
		await writeFile(filePath, "{");

		await expect(new SkillUsageStore(filePath).record(["cron"], new Date())).rejects.toThrow(
			"JSON",
		);
		expect(await readFile(filePath, "utf8")).toBe("{");
	});
});
