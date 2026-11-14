import { constants } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import { hasErrorCode } from "../../../shared/error-code";
import type { WorkspaceConfig } from "../domain/workspace-config";
import type { WorkspaceSchedule } from "../domain/workspace-schedule";
import { createWorkspaceConfigFile, readWorkspaceConfig } from "./config-toml";
import { createWorkspaceScheduleFile, readWorkspaceSchedule } from "./schedule-toml";

const INITIAL_WORKSPACE_FILES = [
	"LUNA.md",
	"MEMORY.md",
	"HEARTBEAT.md",
	"AGENDA.md",
	".agents/skills/cron/SKILL.md",
	".agents/skills/heartbeat/SKILL.md",
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
		await Promise.all([
			mkdir(workspaceDir, { recursive: true }),
			mkdir(tasksDir, { recursive: true }),
		]);
		await createIfMissing(async () => {
			await createWorkspaceConfigFile(configPath);
		});
		await Promise.all(
			INITIAL_WORKSPACE_FILES.map(async (fileName) => {
				await copyTemplateIfMissing(templatesDir, workspaceDir, fileName);
			}),
		);
		await createIfMissing(async () => {
			await createWorkspaceScheduleFile(cronPath);
		});

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

async function copyTemplateIfMissing(
	templatesDir: string,
	workspaceDir: string,
	fileName: (typeof INITIAL_WORKSPACE_FILES)[number],
): Promise<void> {
	const destinationPath = resolve(workspaceDir, fileName);
	await mkdir(dirname(destinationPath), { recursive: true });
	try {
		await access(destinationPath);
		return;
	} catch {
		// The destination is missing or inaccessible; copyFile below reports the actionable cause.
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
