import { resolve } from "node:path";

const SYSTEM_SKILL_NAMES = ["skill-creator", "skill-installer"] as const;

export function buildThreadConfig(
  discordMcpServerUrl: string,
  workspaceDir: string,
  codexHomeDir: string,
): Record<string, unknown> {
  const resolvedWorkspaceDir = resolve(workspaceDir);
  const resolvedCodexHomeDir = resolve(codexHomeDir);

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
    skills: {
      config: SYSTEM_SKILL_NAMES.map((skillName) => {
        return {
          enabled: false,
          path: resolve(resolvedCodexHomeDir, "skills", ".system", skillName, "SKILL.md"),
        };
      }),
    },
  };
}
