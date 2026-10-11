import { randomUUID } from "node:crypto";

import type { AgentThreadInput } from "../modules/agent/ports/outbound/agent-runtime-port";
import { readWorkspaceBaseInstructions } from "../modules/workspace/application/workspace-instructions";
import type { DailyMemory } from "../modules/workspace/application/workspace-instructions";
import type { JsonObject } from "../shared/json";
import { LUNA_DEVELOPER_INSTRUCTIONS } from "./developer-instructions";

export function buildBaseInstructions(input: {
	luna: string | undefined;
	memory: string | undefined;
	dailyMemories: readonly DailyMemory[];
}): string {
	return [
		input.luna,
		input.memory,
		...input.dailyMemories.map((daily) => `# memory/${daily.date}.md\n\n${daily.content}`),
	]
		.filter((content) => content !== undefined)
		.join("\n\n");
}

export function buildCodexThreadConfig(mcpServers: JsonObject, workspaceDir: string): JsonObject {
	return {
		mcp_servers: mcpServers,
		projects: { [workspaceDir]: { trust_level: "trusted" } },
	};
}

export function createThreadInputFactory(input: {
	buildMcpServers: (executionOwnerId: string) => JsonObject;
	capabilityInstructions: readonly string[];
	now: () => Date;
	workspaceDir: string;
	createExecutionOwnerId?: (() => string) | undefined;
}): () => Promise<AgentThreadInput & { executionOwnerId: string }> {
	const createExecutionOwnerId = input.createExecutionOwnerId ?? randomUUID;
	return async () => {
		const executionOwnerId = createExecutionOwnerId();
		const instructions = await readWorkspaceBaseInstructions(input.workspaceDir, input.now());
		return {
			baseInstructions: buildBaseInstructions(instructions),
			config: buildCodexThreadConfig(input.buildMcpServers(executionOwnerId), input.workspaceDir),
			cwd: input.workspaceDir,
			developerInstructions: [LUNA_DEVELOPER_INSTRUCTIONS, ...input.capabilityInstructions].join(
				"\n\n",
			),
			executionOwnerId,
		};
	};
}
