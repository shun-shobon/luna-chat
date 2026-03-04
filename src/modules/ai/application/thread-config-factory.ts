export function buildThreadConfig(discordMcpServerUrl: string): Record<string, unknown> {
  return {
    mcp_servers: {
      discord: {
        url: discordMcpServerUrl,
      },
    },
  };
}
