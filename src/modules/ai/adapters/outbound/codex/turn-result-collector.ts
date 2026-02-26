import type { JsonRpcNotificationMessage } from "./json-rpc-client";

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

type TurnTracker = {
  deltaText: string;
  errorMessage?: string;
  latestAgentMessageText?: string;
  mcpToolCalls: Array<{
    arguments: unknown;
    result: unknown;
    server: string;
    status: "completed" | "failed" | "inProgress";
    tool: string;
  }>;
  completedStatus?: "completed" | "failed" | "interrupted";
};

type ParsedCompletedItem =
  | {
      kind: "agentMessage";
      text: string;
    }
  | {
      kind: "mcpToolCall";
      arguments: unknown;
      result: unknown;
      server: string;
      status: "completed" | "failed" | "inProgress";
      tool: string;
    }
  | {
      kind: "other";
    };

export function createTurnTracker(): TurnTracker {
  return {
    deltaText: "",
    mcpToolCalls: [],
  };
}

export function handleTurnNotification(
  notification: JsonRpcNotificationMessage,
  tracker: TurnTracker,
): void {
  if (notification.method === "item/agentMessage/delta") {
    const params = parseAgentMessageDeltaParams(notification.params);
    if (params) {
      tracker.deltaText += params.delta;
    }
    return;
  }

  if (notification.method === "item/completed") {
    const item = parseItemCompleted(notification.params);
    if (!item) {
      return;
    }

    if (item.kind === "agentMessage") {
      tracker.latestAgentMessageText = item.text;
      return;
    }

    if (item.kind === "mcpToolCall") {
      tracker.mcpToolCalls.push({
        arguments: item.arguments,
        result: item.result,
        server: item.server,
        status: item.status,
        tool: item.tool,
      });
    }
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

function parseItemCompleted(params: unknown): ParsedCompletedItem | undefined {
  if (!isRecord(params)) {
    return undefined;
  }

  const item = params["item"];
  if (!isRecord(item)) {
    return undefined;
  }

  const itemType = item["type"];
  if (itemType === "agent_message") {
    const text = parseAgentMessageText(item["message"]);
    if (text === undefined) {
      return undefined;
    }

    return {
      kind: "agentMessage",
      text,
    };
  }

  if (itemType === "mcp_tool_call") {
    const server = item["server"];
    const tool = item["tool"];
    const status = item["status"];

    if (
      typeof server !== "string" ||
      typeof tool !== "string" ||
      (status !== "completed" && status !== "failed" && status !== "in_progress")
    ) {
      return {
        kind: "other",
      };
    }

    return {
      arguments: item["arguments"],
      kind: "mcpToolCall",
      result: item["result"],
      server,
      status: status === "in_progress" ? "inProgress" : status,
      tool,
    };
  }

  return {
    kind: "other",
  };
}

function parseAgentMessageText(message: unknown): string | undefined {
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

function parseTurnCompletedParams(
  params: unknown,
): { status: string; errorMessage?: string } | undefined {
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

  const errorMessage = turn["error_message"];
  return {
    ...(typeof errorMessage === "string" ? { errorMessage } : {}),
    status,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
