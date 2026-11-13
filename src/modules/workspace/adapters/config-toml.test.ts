import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_CONFIG } from "../domain/workspace-config";
import {
	createWorkspaceConfigFile,
	parseWorkspaceConfig,
	readWorkspaceConfig,
	serializeWorkspaceConfig,
} from "./config-toml";

const temporaryDirectories: string[] = [];
const MEMORY_CONFIG_SOURCE = `[memory]
enabled = true
maintenance_cron = "0 4 * * *"
`;

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (path) => {
			await rm(path, { force: true, recursive: true });
		}),
	);
});

describe("workspace config TOML", () => {
	it("memory設定を必須とし、他sectionのデフォルト値を補う", () => {
		expect(parseWorkspaceConfig(MEMORY_CONFIG_SOURCE)).toEqual(DEFAULT_WORKSPACE_CONFIG);
	});

	it("指定値だけを上書きし、未指定フィールドにはデフォルト値を補う", () => {
		expect(
			parseWorkspaceConfig(`${MEMORY_CONFIG_SOURCE}
[discord]
allowed_channel_ids = ["123", "456"]
allow_dm = false

[heartbeat]
min_interval_ms = 1000
max_interval_ms = 2000
`),
		).toEqual({
			...DEFAULT_WORKSPACE_CONFIG,
			discord: {
				...DEFAULT_WORKSPACE_CONFIG.discord,
				allowDm: false,
				allowedChannelIds: ["123", "456"],
			},
			heartbeat: {
				...DEFAULT_WORKSPACE_CONFIG.heartbeat,
				maxIntervalMs: 2_000,
				minIntervalMs: 1_000,
			},
		});
	});

	it("modelsは provider/model を分けて読み、省略した項目だけデフォルト値を補う", () => {
		expect(
			parseWorkspaceConfig(`${MEMORY_CONFIG_SOURCE}
[agent]
request_timeout_ms = 60000

[models.conversation]
model = "anthropic/claude-opus-5/2026"
thinking = "high"

[models.worker]
thinking = "xhigh"
`),
		).toEqual({
			...DEFAULT_WORKSPACE_CONFIG,
			agent: { ...DEFAULT_WORKSPACE_CONFIG.agent, requestTimeoutMs: 60_000 },
			models: {
				...DEFAULT_WORKSPACE_CONFIG.models,
				conversation: { provider: "anthropic", model: "claude-opus-5/2026", thinking: "high" },
				worker: { ...DEFAULT_WORKSPACE_CONFIG.models.worker, thinking: "xhigh" },
			},
		});
	});

	it.each([
		["unknown top-level key", "unexpected = true"],
		["unknown nested key", "[discord]\nunexpected = true"],
		["non-snowflake channel id", '[discord]\nallowed_channel_ids = ["channel"]'],
		["heartbeat interval inversion", "[heartbeat]\nmin_interval_ms = 2000\nmax_interval_ms = 1000"],
		["removed Codex agent key", "[agent]\nrpc_timeout_ms = 1000"],
		["removed thread retention key", "[agent]\nthread_retention_ms = 1000"],
		["model without provider", '[models.event]\nmodel = "gpt-6.1-sol"'],
		["model with whitespace", '[models.event]\nmodel = "openai-codex/gpt 6"'],
		["unknown thinking level", '[models.event]\nthinking = "max"'],
		["unknown model role", '[models.summary]\nmodel = "openai-codex/gpt-6.1-sol"'],
		["unknown model key", '[models.event]\neffort = "high"'],
		["negative history limit", "[discord]\ninitial_history_limit = -1"],
		["zero duration", "[discord]\ndebounce_ms = 0"],
		["zero task concurrency", "[tasks]\nmax_concurrent = 0"],
		["unsafe integer", "[agent]\ntranscript_retention_ms = 9007199254740992"],
		["timer duration above Node.js limit", "[discord]\nsession_idle_ms = 2147483648"],
		["request timeout above Node.js limit", "[agent]\nrequest_timeout_ms = 2147483648"],
		["zero transcript cleanup interval", "[agent]\ntranscript_cleanup_interval_ms = 0"],
		["invalid memory cron", '[memory]\nenabled = true\nmaintenance_cron = "0 0 4 * * *"'],
	])("%s を拒否する", (_title, source) => {
		expect(() =>
			parseWorkspaceConfig(
				source.includes("[memory]") ? source : `${MEMORY_CONFIG_SOURCE}${source}`,
			),
		).toThrow("config.toml is invalid");
	});

	it("memory sectionがなければ拒否する", () => {
		expect(() => parseWorkspaceConfig("")).toThrow("config.toml is invalid");
	});

	it("全設定を TOML に直列化して往復できる", () => {
		const source = serializeWorkspaceConfig(DEFAULT_WORKSPACE_CONFIG);

		expect(source).toContain("allowed_channel_ids = []");
		expect(source).toContain("transcript_retention_ms = 604800000");
		expect(source).toContain('model = "openai-codex/gpt-6.1-terra"');
		expect(source).toContain('maintenance_cron = "0 4 * * *"');
		expect(parseWorkspaceConfig(source)).toEqual(DEFAULT_WORKSPACE_CONFIG);
	});

	it("設定ファイルを排他的に作成し、既存ファイルを上書きしない", async () => {
		const directory = await createTemporaryDirectory();
		const configPath = resolve(directory, "config.toml");

		await createWorkspaceConfigFile(configPath);
		await expect(readWorkspaceConfig(configPath)).resolves.toEqual(DEFAULT_WORKSPACE_CONFIG);
		await expect(createWorkspaceConfigFile(configPath)).rejects.toMatchObject({ code: "EEXIST" });
		await expect(readFile(configPath, "utf8")).resolves.toBe(
			serializeWorkspaceConfig(DEFAULT_WORKSPACE_CONFIG),
		);
	});
});

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "luna-workspace-config-"));
	temporaryDirectories.push(directory);
	return directory;
}
