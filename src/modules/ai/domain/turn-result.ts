export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type TurnTokenUsage = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
};

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
  tokenUsage?: TurnTokenUsage;
  status: "completed" | "failed" | "interrupted";
};
