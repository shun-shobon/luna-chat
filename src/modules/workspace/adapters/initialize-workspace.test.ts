import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_CONFIG } from "../domain/workspace-config";
import { initializeWorkspace } from "./initialize-workspace";

const STARTER_FILES = [
	"memory/topics/know-how.md",
	"users/README.md",
	".agents/skills/self-review/SKILL.md",
	".agents/skills/self-review/scripts/negatives.py",
	".agents/skills/self-review/scripts/runs.py",
	".agents/skills/self-review/scripts/scene.py",
	".agents/skills/x-status-fetch/SKILL.md",
	".agents/skills/x-status-fetch/scripts/fetch_x_status.py",
];

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (path) => {
			await rm(path, { force: true, recursive: true });
		}),
	);
});

describe("workspace initializer adapter", () => {
	it("LUNA_HOME 配下の構造と初期ファイルを生成する", async () => {
		const root = await createTemporaryDirectory();
		const templatesDir = await createTemplates(root);
		const lunaHome = resolve(root, "home");

		const initialized = await initializeWorkspace({ lunaHome, templatesDir });

		expect(initialized).toEqual({
			config: DEFAULT_WORKSPACE_CONFIG,
			configPath: resolve(lunaHome, "config.toml"),
			cronPath: resolve(lunaHome, "workspace", "cron.toml"),
			lunaHomeDir: lunaHome,
			schedule: { jobs: [] },
			tasksDir: resolve(lunaHome, "tasks"),
			workspaceDir: resolve(lunaHome, "workspace"),
		});
		await expect(readFile(resolve(lunaHome, "workspace", "LUNA.md"), "utf8")).resolves.toBe(
			"luna template",
		);
		await expect(readFile(resolve(lunaHome, "workspace", "MEMORY.md"), "utf8")).resolves.toBe(
			"memory template",
		);
		await expect(readFile(resolve(lunaHome, "workspace", "HEARTBEAT.md"), "utf8")).resolves.toBe(
			"heartbeat template",
		);
		await expect(readFile(resolve(lunaHome, "workspace", "AGENDA.md"), "utf8")).resolves.toBe(
			"agenda template",
		);
		await expect(
			readFile(resolve(lunaHome, "workspace", ".agents/skills/cron/SKILL.md"), "utf8"),
		).resolves.toBe("cron skill template");
		await expect(
			readFile(resolve(lunaHome, "workspace", ".agents/skills/heartbeat/SKILL.md"), "utf8"),
		).resolves.toBe("heartbeat skill template");
		await expect(readFile(resolve(lunaHome, "workspace", "cron.toml"), "utf8")).resolves.toBe(
			"jobs = []\n",
		);
		await expect(
			readFile(resolve(lunaHome, "workspace", "memory/topics/know-how.md"), "utf8"),
		).resolves.toBe("starter template");
		await expect(
			readFile(
				resolve(lunaHome, "workspace", ".agents/skills/x-status-fetch/scripts/fetch_x_status.py"),
				"utf8",
			),
		).resolves.toBe("starter template");
	});

	it("既存のワークスペースには追加の初期ファイルを作らない", async () => {
		const root = await createTemporaryDirectory();
		const templatesDir = await createTemplates(root);
		const lunaHome = resolve(root, "home");
		const workspaceDir = resolve(lunaHome, "workspace");
		await mkdir(workspaceDir, { recursive: true });

		await initializeWorkspace({ lunaHome, templatesDir });

		await expect(readFile(resolve(workspaceDir, "LUNA.md"), "utf8")).resolves.toBe("luna template");
		await expect(access(resolve(workspaceDir, "users/README.md"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(
			access(resolve(workspaceDir, ".agents/skills/self-review/SKILL.md")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("同梱のテンプレートで新しいワークスペースを初期化できる", async () => {
		const root = await createTemporaryDirectory();
		const lunaHome = resolve(root, "home");

		const initialized = await initializeWorkspace({
			lunaHome,
			templatesDir: resolve(import.meta.dirname, "../../../../templates"),
		});

		expect(initialized.schedule.jobs).toEqual([
			expect.objectContaining({ id: "self-review-weekly", kind: "recurring" }),
		]);
		await expect(
			access(resolve(lunaHome, "workspace", ".agents/skills/self-review/scripts/scene.py")),
		).resolves.toBeUndefined();
	});

	it("既存ファイルを上書きしない", async () => {
		const root = await createTemporaryDirectory();
		const templatesDir = await createTemplates(root);
		const lunaHome = resolve(root, "home");
		const workspaceDir = resolve(lunaHome, "workspace");
		await mkdir(workspaceDir, { recursive: true });
		await writeFile(resolve(workspaceDir, "LUNA.md"), "custom luna");
		await mkdir(resolve(workspaceDir, ".agents/skills/cron"), { recursive: true });
		await writeFile(resolve(workspaceDir, ".agents/skills/cron/SKILL.md"), "custom cron skill");

		await initializeWorkspace({ lunaHome, templatesDir });

		await expect(readFile(resolve(workspaceDir, "LUNA.md"), "utf8")).resolves.toBe("custom luna");
		await expect(
			readFile(resolve(workspaceDir, ".agents/skills/cron/SKILL.md"), "utf8"),
		).resolves.toBe("custom cron skill");
	});

	it("初期文書がすべて存在すればtemplate directoryを要求しない", async () => {
		const root = await createTemporaryDirectory();
		const lunaHome = resolve(root, "home");
		const workspaceDir = resolve(lunaHome, "workspace");
		await mkdir(workspaceDir, { recursive: true });
		await Promise.all([
			writeFile(resolve(workspaceDir, "LUNA.md"), "custom luna"),
			writeFile(resolve(workspaceDir, "MEMORY.md"), "custom memory"),
			writeFile(resolve(workspaceDir, "HEARTBEAT.md"), "custom heartbeat"),
			writeFile(resolve(workspaceDir, "AGENDA.md"), "custom agenda"),
			writeFile(resolve(workspaceDir, "cron.toml"), "jobs = []\n"),
		]);
		await mkdir(resolve(workspaceDir, ".agents/skills/cron"), { recursive: true });
		await mkdir(resolve(workspaceDir, ".agents/skills/heartbeat"), { recursive: true });
		await Promise.all([
			writeFile(resolve(workspaceDir, ".agents/skills/cron/SKILL.md"), "custom cron skill"),
			writeFile(
				resolve(workspaceDir, ".agents/skills/heartbeat/SKILL.md"),
				"custom heartbeat skill",
			),
		]);

		await expect(
			initializeWorkspace({ lunaHome, templatesDir: resolve(root, "missing-templates") }),
		).resolves.toMatchObject({ workspaceDir });
	});

	it.each(["", "   ", "relative/path"])(
		"相対または空の LUNA_HOME %j を拒否する",
		async (lunaHome) => {
			await expect(initializeWorkspace({ lunaHome, templatesDir: "/unused" })).rejects.toThrow(
				"LUNA_HOME must be an absolute path.",
			);
		},
	);

	it("既存 config.toml が不正なら起動に失敗する", async () => {
		const root = await createTemporaryDirectory();
		const templatesDir = await createTemplates(root);
		const lunaHome = resolve(root, "home");
		await mkdir(lunaHome, { recursive: true });
		await writeFile(resolve(lunaHome, "config.toml"), "unknown = true\n");

		await expect(initializeWorkspace({ lunaHome, templatesDir })).rejects.toThrow(
			"workspace initialization failed.",
		);
	});

	it("既存 cron.toml が不正なら起動に失敗する", async () => {
		const root = await createTemporaryDirectory();
		const templatesDir = await createTemplates(root);
		const lunaHome = resolve(root, "home");
		const workspaceDir = resolve(lunaHome, "workspace");
		await mkdir(workspaceDir, { recursive: true });
		await writeFile(resolve(workspaceDir, "cron.toml"), "unknown = true\n");

		await expect(initializeWorkspace({ lunaHome, templatesDir })).rejects.toThrow(
			"workspace initialization failed.",
		);
	});

	it("必要なテンプレートがなければ起動に失敗する", async () => {
		const root = await createTemporaryDirectory();
		const templatesDir = resolve(root, "templates");
		await mkdir(templatesDir);

		await expect(
			initializeWorkspace({ lunaHome: resolve(root, "home"), templatesDir }),
		).rejects.toThrow("failed to initialize");
	});

	it("必要な SKILL.md がなければ起動に失敗する", async () => {
		const root = await createTemporaryDirectory();
		const templatesDir = await createTemplates(root);
		await rm(resolve(templatesDir, ".agents/skills/cron/SKILL.md"));

		await expect(
			initializeWorkspace({ lunaHome: resolve(root, "home"), templatesDir }),
		).rejects.toThrow("failed to initialize .agents/skills/cron/SKILL.md");
	});
});

async function createTemplates(root: string): Promise<string> {
	const templatesDir = resolve(root, "templates");
	await mkdir(templatesDir);
	await mkdir(resolve(templatesDir, ".agents/skills/cron"), { recursive: true });
	await mkdir(resolve(templatesDir, ".agents/skills/heartbeat"), { recursive: true });
	await Promise.all([
		writeFile(resolve(templatesDir, "LUNA.md"), "luna template"),
		writeFile(resolve(templatesDir, "MEMORY.md"), "memory template"),
		writeFile(resolve(templatesDir, "HEARTBEAT.md"), "heartbeat template"),
		writeFile(resolve(templatesDir, "AGENDA.md"), "agenda template"),
		writeFile(resolve(templatesDir, "cron.toml"), "jobs = []\n"),
		writeFile(resolve(templatesDir, ".agents/skills/cron/SKILL.md"), "cron skill template"),
		writeFile(
			resolve(templatesDir, ".agents/skills/heartbeat/SKILL.md"),
			"heartbeat skill template",
		),
	]);
	await Promise.all(
		STARTER_FILES.map(async (fileName) => {
			const path = resolve(templatesDir, fileName);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, "starter template");
		}),
	);
	return templatesDir;
}

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "luna-workspace-initialize-"));
	temporaryDirectories.push(directory);
	return directory;
}
