import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { AgentThreadInput } from "../modules/agent/ports/outbound/agent-runtime-port";
import { readWorkspaceBaseInstructions } from "../modules/workspace/application/workspace-instructions";

import { LUNA_DEVELOPER_INSTRUCTIONS } from "./developer-instructions";

export function buildBaseInstructions(input: {
  luna: string | undefined;
  memory: string | undefined;
}): string {
  return [input.luna, input.memory].filter((content) => content !== undefined).join("\n\n");
}

export function buildCodexThreadConfig(
  mcpServers: Readonly<Record<string, unknown>>,
  workspaceDir: string,
): Record<string, unknown> {
  const resolvedWorkspaceDir = resolve(workspaceDir);
  return {
    mcp_servers: mcpServers,
    projects: { [resolvedWorkspaceDir]: { trust_level: "trusted" } },
  };
}

export function createThreadInputFactory(input: {
  buildMcpServers: (executionOwnerId: string) => Readonly<Record<string, unknown>>;
  capabilityInstructions: readonly string[];
  workspaceDir: string;
  createExecutionOwnerId?: (() => string) | undefined;
}): () => Promise<AgentThreadInput> {
  const createExecutionOwnerId = input.createExecutionOwnerId ?? randomUUID;
  return async () => {
    const executionOwnerId = createExecutionOwnerId();
    const instructions = await readWorkspaceBaseInstructions(input.workspaceDir);
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
