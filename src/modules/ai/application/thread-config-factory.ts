import type { ReasoningEffort } from "../../../ai/codex-generated/ReasoningEffort";

export function buildThreadConfig(
  reasoningEffort: ReasoningEffort,
  discordMcpServerUrl: string,
): Record<string, unknown> {
  return {
    mcp_servers: {
      discord: {
        url: discordMcpServerUrl,
      },
    },
    model_reasoning_effort: reasoningEffort,
  };
}
