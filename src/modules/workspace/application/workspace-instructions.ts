import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type WorkspaceBaseInstructions = {
	luna: string | undefined;
	memory: string | undefined;
};

class WorkspaceInstructionError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkspaceInstructionError";
	}
}

export async function readWorkspaceBaseInstructions(
	workspaceDir: string,
): Promise<WorkspaceBaseInstructions> {
	const [luna, memory] = await Promise.all([
		readOptionalInstruction(resolve(workspaceDir, "LUNA.md")),
		readOptionalInstruction(resolve(workspaceDir, "MEMORY.md")),
	]);
	return { luna, memory };
}

export async function readHeartbeatContext(
	workspaceDir: string,
): Promise<Readonly<{ checklist: string; agenda: string }>> {
	const checklist = await readRequiredInstruction(workspaceDir, "HEARTBEAT.md");
	const agenda = await readRequiredInstruction(workspaceDir, "AGENDA.md");
	return { checklist, agenda };
}

async function readRequiredInstruction(workspaceDir: string, fileName: string): Promise<string> {
	try {
		return await readFile(resolve(workspaceDir, fileName), "utf8");
	} catch (error: unknown) {
		throw new WorkspaceInstructionError(`${fileName} must be readable.`, { cause: error });
	}
}

async function readOptionalInstruction(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}
