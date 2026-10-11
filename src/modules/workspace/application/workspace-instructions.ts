import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { formatLocalDate } from "../../../shared/local-date";

export type DailyMemory = Readonly<{ date: string; content: string }>;

type WorkspaceBaseInstructions = {
	luna: string | undefined;
	memory: string | undefined;
	dailyMemories: readonly DailyMemory[];
};

class WorkspaceInstructionError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkspaceInstructionError";
	}
}

export async function readWorkspaceBaseInstructions(
	workspaceDir: string,
	now: Date,
): Promise<WorkspaceBaseInstructions> {
	const dates = [
		formatLocalDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)),
		formatLocalDate(now),
	];
	const [luna, memory, ...daily] = await Promise.all([
		readOptionalInstruction(resolve(workspaceDir, "LUNA.md")),
		readOptionalInstruction(resolve(workspaceDir, "MEMORY.md")),
		...dates.map(
			async (date) => await readOptionalInstruction(resolve(workspaceDir, "memory", `${date}.md`)),
		),
	]);
	const dailyMemories = dates.flatMap((date, index) => {
		const content = daily[index];
		return content === undefined ? [] : [{ date, content }];
	});

	return { luna, memory, dailyMemories };
}

export async function readHeartbeatChecklist(workspaceDir: string): Promise<string> {
	try {
		return await readFile(resolve(workspaceDir, "HEARTBEAT.md"), "utf8");
	} catch (error: unknown) {
		throw new WorkspaceInstructionError("HEARTBEAT.md must be readable.", { cause: error });
	}
}

async function readOptionalInstruction(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}
