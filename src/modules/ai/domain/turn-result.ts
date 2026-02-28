export type TurnResult = {
  assistantText: string;
  errorMessage?: string;
  mcpToolCalls: Array<{
    arguments: unknown;
    result: unknown;
    server: string;
    status: "completed" | "failed" | "inProgress";
    tool: string;
  }>;
  status: "completed" | "failed" | "interrupted";
};
