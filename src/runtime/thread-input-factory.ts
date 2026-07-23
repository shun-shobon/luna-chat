import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { ConversationThreadInput } from "../modules/conversation/application/conversation-coordinator";
import { readWorkspaceBaseInstructions } from "../modules/workspace/application/workspace-instructions";

import { LUNA_DEVELOPER_INSTRUCTIONS } from "./developer-instructions";

export function buildBaseInstructions(input: {
  luna: string | undefined;
  memory: string | undefined;
}): string {
  return [input.luna, input.memory].filter((content) => content !== undefined).join("\n\n");
}

export function buildCodexThreadConfig(
  discordMcpServerUrl: string,
  workspaceDir: string,
  actionOwnerId: string,
): Record<string, unknown> {
  const resolvedWorkspaceDir = resolve(workspaceDir);
  return {
    mcp_servers: {
      discord: {
        url: discordMcpServerUrl,
        http_headers: { "X-Luna-Typing-Owner": actionOwnerId },
      },
    },
    projects: { [resolvedWorkspaceDir]: { trust_level: "trusted" } },
  };
}

export function createThreadInputFactory(input: {
  discordMcpServerUrl: string;
  workspaceDir: string;
  createActionOwnerId?: (() => string) | undefined;
}): () => Promise<ConversationThreadInput> {
  const createActionOwnerId = input.createActionOwnerId ?? randomUUID;
  return async () => {
    const actionOwnerId = createActionOwnerId();
    const instructions = await readWorkspaceBaseInstructions(input.workspaceDir);
    return {
      actionOwnerId,
      baseInstructions: buildBaseInstructions(instructions),
      config: buildCodexThreadConfig(input.discordMcpServerUrl, input.workspaceDir, actionOwnerId),
      cwd: input.workspaceDir,
      developerInstructions: LUNA_DEVELOPER_INSTRUCTIONS,
    };
  };
}
