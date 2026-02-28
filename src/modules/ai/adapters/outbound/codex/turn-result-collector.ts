import type { TokenUsageBreakdown, TurnResult, TurnTokenUsage } from "../../../domain/turn-result";

import type { JsonRpcNotificationMessage } from "./json-rpc-client";

type McpToolCallStatus = "completed" | "failed" | "inProgress";

type TurnTracker = {
  expectedThreadId?: string;
  activeTurnId?: string;
  deltaText: string;
  errorMessage?: string;
  latestAgentMessageText?: string;
  mcpToolCalls: Array<{
    arguments: unknown;
    result: unknown;
    server: string;
    status: McpToolCallStatus;
    tool: string;
  }>;
  tokenUsage?: TurnTokenUsage;
  completedStatus?: "completed" | "failed" | "interrupted";
};

type ParsedCompletedItem =
  | {
      kind: "agentMessage";
      text: string;
      threadId?: string;
      turnId?: string;
    }
  | {
      kind: "mcpToolCall";
      arguments: unknown;
      result: unknown;
      server: string;
      status: McpToolCallStatus;
      tool: string;
      threadId?: string;
      turnId?: string;
    }
  | {
      kind: "other";
    };

type ParsedStartedItem =
  | {
      kind: "mcpToolCall";
      server: string;
      tool: string;
      threadId?: string;
      turnId?: string;
    }
  | {
      kind: "other";
    };

type ParsedTurnCompleted = {
  turnId?: string;
  threadId?: string;
  status: string;
  errorMessage?: string;
};

type ParsedTokenUsageUpdated = {
  threadId?: string;
  turnId?: string;
  tokenUsage: TurnTokenUsage;
};

export type McpToolCallStartedNotification = {
  threadId: string;
  turnId: string;
  server: string;
  tool: string;
};

export type McpToolCallCompletedNotification = {
  threadId: string;
  turnId: string;
  server: string;
  tool: string;
  status: McpToolCallStatus;
};

export type TurnNotificationObserver = {
  onMcpToolCallStarted?: (event: McpToolCallStartedNotification) => void;
  onMcpToolCallCompleted?: (event: McpToolCallCompletedNotification) => void;
};

export function createTurnTracker(input: { threadId?: string } = {}): TurnTracker {
  return {
    ...(input.threadId ? { expectedThreadId: input.threadId } : {}),
    deltaText: "",
    mcpToolCalls: [],
  };
}

export function bindTrackerToTurn(tracker: TurnTracker, turnId: string): void {
  tracker.activeTurnId = turnId;
}

export function handleTurnNotification(
  notification: JsonRpcNotificationMessage,
  tracker: TurnTracker,
  observer?: TurnNotificationObserver,
): void {
  if (notification.method === "item/agentMessage/delta") {
    const params = parseAgentMessageDeltaParams(notification.params);
    if (params) {
      tracker.deltaText += params.delta;
    }
    return;
  }

  if (notification.method === "item/started") {
    const item = parseItemStarted(notification.params);
    if (
      item?.kind === "mcpToolCall" &&
      shouldHandleTurnScopedEvent(tracker, item.threadId, item.turnId)
    ) {
      if (item.threadId && item.turnId) {
        observer?.onMcpToolCallStarted?.({
          server: item.server,
          threadId: item.threadId,
          tool: item.tool,
          turnId: item.turnId,
        });
      }
    }
    return;
  }

  if (notification.method === "item/completed") {
    const item = parseItemCompleted(notification.params);
    if (!item || item.kind === "other") {
      return;
    }

    if (!shouldHandleTurnScopedEvent(tracker, item.threadId, item.turnId)) {
      return;
    }

    if (item.kind === "agentMessage") {
      tracker.latestAgentMessageText = item.text;
      return;
    }

    tracker.mcpToolCalls.push({
      arguments: item.arguments,
      result: item.result,
      server: item.server,
      status: item.status,
      tool: item.tool,
    });

    if (item.threadId && item.turnId) {
      observer?.onMcpToolCallCompleted?.({
        server: item.server,
        status: item.status,
        threadId: item.threadId,
        tool: item.tool,
        turnId: item.turnId,
      });
    }
    return;
  }

  if (notification.method === "thread/tokenUsage/updated") {
    const params = parseThreadTokenUsageUpdated(notification.params);
    if (!params) {
      return;
    }
    if (!shouldHandleTurnScopedEvent(tracker, params.threadId, params.turnId)) {
      return;
    }

    tracker.tokenUsage = params.tokenUsage;
    return;
  }

  if (notification.method === "error") {
    const params = parseErrorParams(notification.params);
    if (params) {
      tracker.errorMessage = params.errorMessage;
    }
    return;
  }

  if (notification.method === "turn/completed") {
    const params = parseTurnCompletedParams(notification.params);
    if (!params) {
      return;
    }
    if (!shouldHandleTurnScopedEvent(tracker, params.threadId, params.turnId)) {
      return;
    }

    if (
      params.status === "completed" ||
      params.status === "failed" ||
      params.status === "interrupted"
    ) {
      tracker.completedStatus = params.status;
    } else {
      tracker.completedStatus = "failed";
    }

    if (!tracker.errorMessage && params.errorMessage) {
      tracker.errorMessage = params.errorMessage;
    }
  }
}

export async function waitForTurnCompletion(input: {
  timeoutMs: number;
  onTimeout: () => Promise<void>;
  tracker: TurnTracker;
}): Promise<TurnResult> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= input.timeoutMs) {
    if (input.tracker.completedStatus) {
      const assistantText = input.tracker.latestAgentMessageText ?? input.tracker.deltaText.trim();
      const turnResult: TurnResult = {
        assistantText,
        mcpToolCalls: input.tracker.mcpToolCalls,
        status: input.tracker.completedStatus,
        ...(input.tracker.tokenUsage ? { tokenUsage: input.tracker.tokenUsage } : {}),
      };
      if (input.tracker.errorMessage) {
        turnResult.errorMessage = input.tracker.errorMessage;
      }

      return turnResult;
    }

    await wait(10);
  }

  await input.onTimeout();
  return {
    assistantText: input.tracker.latestAgentMessageText ?? input.tracker.deltaText.trim(),
    errorMessage: `turn timed out after ${input.timeoutMs}ms`,
    mcpToolCalls: input.tracker.mcpToolCalls,
    ...(input.tracker.tokenUsage ? { tokenUsage: input.tracker.tokenUsage } : {}),
    status: "failed",
  };
}

function parseAgentMessageDeltaParams(params: unknown): { delta: string } | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const delta = params["delta"];
  if (typeof delta !== "string") {
    return undefined;
  }

  return {
    delta,
  };
}

function parseItemStarted(params: unknown): ParsedStartedItem | undefined {
  if (!isRecord(params)) {
    return undefined;
  }

  const item = params["item"];
  if (!isRecord(item)) {
    return undefined;
  }

  if (!isMcpToolCallItemType(item["type"])) {
    return {
      kind: "other",
    };
  }

  const server = getStringValue(item, ["server"]);
  const tool = getStringValue(item, ["tool"]);
  if (!server || !tool) {
    return {
      kind: "other",
    };
  }

  const threadId = getStringValue(params, ["threadId", "thread_id"]);
  const turnId = getStringValue(params, ["turnId", "turn_id"]);

  return {
    kind: "mcpToolCall",
    server,
    tool,
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

function parseItemCompleted(params: unknown): ParsedCompletedItem | undefined {
  if (!isRecord(params)) {
    return undefined;
  }

  const item = params["item"];
  if (!isRecord(item)) {
    return undefined;
  }

  const threadId = getStringValue(params, ["threadId", "thread_id"]);
  const turnId = getStringValue(params, ["turnId", "turn_id"]);

  if (isAgentMessageItemType(item["type"])) {
    const text = parseAgentMessageText(item);
    if (text === undefined) {
      return undefined;
    }

    return {
      kind: "agentMessage",
      text,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
    };
  }

  if (isMcpToolCallItemType(item["type"])) {
    const server = getStringValue(item, ["server"]);
    const tool = getStringValue(item, ["tool"]);
    const status = parseMcpToolCallStatus(item["status"]);

    if (!server || !tool || !status) {
      return {
        kind: "other",
      };
    }

    return {
      arguments: item["arguments"],
      kind: "mcpToolCall",
      result: item["result"],
      server,
      status,
      tool,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
    };
  }

  return {
    kind: "other",
  };
}

function parseAgentMessageText(item: Record<string, unknown>): string | undefined {
  const directText = item["text"];
  if (typeof directText === "string") {
    return directText.trim();
  }

  return parseLegacyAgentMessageText(item["message"]);
}

function parseLegacyAgentMessageText(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }

  const content = message["content"];
  if (!Array.isArray(content)) {
    return undefined;
  }

  const textChunks: string[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) {
      continue;
    }

    if (entry["type"] !== "text") {
      continue;
    }

    const text = entry["text"];
    if (typeof text === "string") {
      textChunks.push(text);
    }
  }

  return textChunks.join("").trim();
}

function parseThreadTokenUsageUpdated(params: unknown): ParsedTokenUsageUpdated | undefined {
  if (!isRecord(params)) {
    return undefined;
  }

  const rawTokenUsage = params["tokenUsage"] ?? params["token_usage"];
  const tokenUsage = parseTurnTokenUsage(rawTokenUsage);
  if (!tokenUsage) {
    return undefined;
  }

  const threadId = getStringValue(params, ["threadId", "thread_id"]);
  const turnId = getStringValue(params, ["turnId", "turn_id"]);

  return {
    tokenUsage,
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

function parseTurnTokenUsage(value: unknown): TurnTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const total = parseTokenUsageBreakdown(value["total"] ?? value["total_token_usage"]);
  const last = parseTokenUsageBreakdown(value["last"] ?? value["last_token_usage"]);
  if (!total || !last) {
    return undefined;
  }

  const modelContextWindowValue = value["modelContextWindow"] ?? value["model_context_window"];
  if (modelContextWindowValue !== null && typeof modelContextWindowValue !== "number") {
    return undefined;
  }

  return {
    last,
    modelContextWindow: modelContextWindowValue ?? null,
    total,
  };
}

function parseTokenUsageBreakdown(value: unknown): TokenUsageBreakdown | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const totalTokens = getNumberValue(value, ["totalTokens", "total_tokens"]);
  const inputTokens = getNumberValue(value, ["inputTokens", "input_tokens"]);
  const cachedInputTokens = getNumberValue(value, ["cachedInputTokens", "cached_input_tokens"]);
  const outputTokens = getNumberValue(value, ["outputTokens", "output_tokens"]);
  const reasoningOutputTokens = getNumberValue(value, [
    "reasoningOutputTokens",
    "reasoning_output_tokens",
  ]);

  if (
    totalTokens === undefined ||
    inputTokens === undefined ||
    cachedInputTokens === undefined ||
    outputTokens === undefined ||
    reasoningOutputTokens === undefined
  ) {
    return undefined;
  }

  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function parseErrorParams(params: unknown): { errorMessage: string } | undefined {
  if (!isRecord(params)) {
    return undefined;
  }

  const error = params["error"];
  if (!isRecord(error)) {
    return undefined;
  }

  const message = error["message"];
  if (typeof message !== "string") {
    return undefined;
  }

  return {
    errorMessage: message,
  };
}

function parseTurnCompletedParams(params: unknown): ParsedTurnCompleted | undefined {
  if (!isRecord(params)) {
    return undefined;
  }

  const turn = params["turn"];
  if (!isRecord(turn)) {
    return undefined;
  }

  const status = turn["status"];
  if (typeof status !== "string") {
    return undefined;
  }

  const errorMessage = getStringValue(turn, ["error", "error_message"]);
  const turnId = getStringValue(turn, ["id", "turn_id"]);
  const threadId = getStringValue(params, ["threadId", "thread_id"]);

  return {
    ...(errorMessage ? { errorMessage } : {}),
    ...(turnId ? { turnId } : {}),
    ...(threadId ? { threadId } : {}),
    status,
  };
}

function shouldHandleTurnScopedEvent(
  tracker: TurnTracker,
  threadId: string | undefined,
  turnId: string | undefined,
): boolean {
  if (threadId && tracker.expectedThreadId && threadId !== tracker.expectedThreadId) {
    return false;
  }

  if (turnId && tracker.activeTurnId && turnId !== tracker.activeTurnId) {
    return false;
  }

  return true;
}

function isAgentMessageItemType(value: unknown): boolean {
  return value === "agentMessage" || value === "agent_message";
}

function isMcpToolCallItemType(value: unknown): boolean {
  return value === "mcpToolCall" || value === "mcp_tool_call";
}

function parseMcpToolCallStatus(value: unknown): McpToolCallStatus | undefined {
  if (value === "completed" || value === "failed") {
    return value;
  }

  if (value === "in_progress" || value === "inProgress") {
    return "inProgress";
  }

  return undefined;
}

function getStringValue(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") {
      return value;
    }
  }

  return undefined;
}

function getNumberValue(
  source: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number") {
      return value;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
