import { constants } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import { hasErrorCode } from "../../../shared/error-code";
import type { WorkspaceConfig } from "../domain/workspace-config";
import type { WorkspaceSchedule } from "../domain/workspace-schedule";
import { createWorkspaceConfigFile, readWorkspaceConfig } from "./config-toml";
import { readWorkspaceSchedule } from "./schedule-toml";

const REQUIRED_WORKSPACE_FILES = [
	"LUNA.md",
	"MEMORY.md",
	"HEARTBEAT.md",
	"AGENDA.md",
	"cron.toml",
	".agents/skills/cron/SKILL.md",
	".agents/skills/heartbeat/SKILL.md",
] as const;

// ルナが整理で移動・改名・アーカイブし得るため、作り直すのは新しいワークスペースの時だけにする。
const STARTER_WORKSPACE_FILES = [
	"memory/topics/know-how.md",
	"users/README.md",
	".agents/skills/self-review/SKILL.md",
	".agents/skills/self-review/scripts/negatives.py",
	".agents/skills/self-review/scripts/runs.py",
	".agents/skills/self-review/scripts/scene.py",
	".agents/skills/x-status-fetch/SKILL.md",
	".agents/skills/x-status-fetch/scripts/fetch_x_status.py",
] as const;

type InitializedWorkspace = {
	config: WorkspaceConfig;
	configPath: string;
	cronPath: string;
	tasksDir: string;
	lunaHomeDir: string;
	schedule: WorkspaceSchedule;
	workspaceDir: string;
};

class WorkspaceInitializationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkspaceInitializationError";
	}
}

export async function initializeWorkspace(input: {
	lunaHome?: string | undefined;
	templatesDir: string;
}): Promise<InitializedWorkspace> {
	const lunaHomeDir = resolveLunaHome(input.lunaHome);
	const workspaceDir = resolve(lunaHomeDir, "workspace");
	const tasksDir = resolve(lunaHomeDir, "tasks");
	const templatesDir = resolve(input.templatesDir);
	const configPath = resolve(lunaHomeDir, "config.toml");
	const cronPath = resolve(workspaceDir, "cron.toml");

	try {
		const isNewWorkspace = !(await exists(workspaceDir));
		await Promise.all([
			mkdir(workspaceDir, { recursive: true }),
			mkdir(tasksDir, { recursive: true }),
		]);
		await createIfMissing(async () => {
			await createWorkspaceConfigFile(configPath);
		});
		const templateFiles: readonly string[] = isNewWorkspace
			? [...REQUIRED_WORKSPACE_FILES, ...STARTER_WORKSPACE_FILES]
			: REQUIRED_WORKSPACE_FILES;
		await Promise.all(
			templateFiles.map(async (fileName) => {
				await copyTemplateIfMissing(templatesDir, workspaceDir, fileName);
			}),
		);

		const [config, schedule] = await Promise.all([
			readWorkspaceConfig(configPath),
			readWorkspaceSchedule(cronPath),
		]);

		return {
			config,
			configPath,
			cronPath,
			lunaHomeDir,
			schedule,
			tasksDir,
			workspaceDir,
		};
	} catch (error: unknown) {
		if (error instanceof WorkspaceInitializationError) {
			throw error;
		}
		throw new WorkspaceInitializationError("workspace initialization failed.", { cause: error });
	}
}

export function resolveLunaHome(rawLunaHome: string | undefined): string {
	if (rawLunaHome === undefined) {
		return resolve(homedir(), ".luna");
	}

	if (!isAbsolute(rawLunaHome)) {
		throw new WorkspaceInitializationError("LUNA_HOME must be an absolute path.");
	}

	return resolve(rawLunaHome);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function copyTemplateIfMissing(
	templatesDir: string,
	workspaceDir: string,
	fileName: string,
): Promise<void> {
	const destinationPath = resolve(workspaceDir, fileName);
	await mkdir(dirname(destinationPath), { recursive: true });
	if (await exists(destinationPath)) {
		return;
	}
	try {
		await copyFile(resolve(templatesDir, fileName), destinationPath, constants.COPYFILE_EXCL);
	} catch (error: unknown) {
		if (hasErrorCode(error, "EEXIST")) {
			return;
		}
		throw new WorkspaceInitializationError(`failed to initialize ${fileName}.`, { cause: error });
	}
}

async function createIfMissing(create: () => Promise<void>): Promise<void> {
	try {
		await create();
	} catch (error: unknown) {
		if (hasErrorCode(error, "EEXIST")) {
			return;
		}
		throw error;
	}
}
