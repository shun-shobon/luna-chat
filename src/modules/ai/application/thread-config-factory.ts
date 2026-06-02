import { resolve } from "node:path";

export function buildThreadConfig(
  discordMcpServerUrl: string,
  workspaceDir: string,
): Record<string, unknown> {
  const resolvedWorkspaceDir = resolve(workspaceDir);

  return {
    mcp_servers: {
      discord: {
        url: discordMcpServerUrl,
      },
    },
    projects: {
      [resolvedWorkspaceDir]: {
        trust_level: "trusted",
      },
    },
  };
}
