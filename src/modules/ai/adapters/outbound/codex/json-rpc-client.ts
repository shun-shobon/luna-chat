import type { ClientNotification } from "../../../../../generated/codex/ClientNotification";
import type { ClientRequest } from "../../../../../generated/codex/ClientRequest";
import type { RequestId } from "../../../../../generated/codex/RequestId";
import type { JsonValue } from "../../../../../generated/codex/serde_json/JsonValue";
import type { CommandExecutionRequestApprovalResponse } from "../../../../../generated/codex/v2/CommandExecutionRequestApprovalResponse";
import type { FileChangeRequestApprovalResponse } from "../../../../../generated/codex/v2/FileChangeRequestApprovalResponse";
import type { ThreadStartParams } from "../../../../../generated/codex/v2/ThreadStartParams";
import type { ToolRequestUserInputQuestion } from "../../../../../generated/codex/v2/ToolRequestUserInputQuestion";
import type { ToolRequestUserInputResponse } from "../../../../../generated/codex/v2/ToolRequestUserInputResponse";
import { logger } from "../../../../../shared/logger";

import type { StdioProcessHandle } from "./stdio-process";

type JsonRpcResponseMessage = {
  id: RequestId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

export type JsonRpcNotificationMessage = {
  method: string;
  params?: unknown;
};

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
};

type ParsedInboundRequest = {
  id: RequestId;
  method: string;
  params: unknown;
};

type SupportedClientRequest =
  | Extract<ClientRequest, { method: "initialize" }>
  | Extract<ClientRequest, { method: "thread/start" }>
  | Extract<ClientRequest, { method: "turn/start" }>
  | Extract<ClientRequest, { method: "turn/steer" }>
  | Extract<ClientRequest, { method: "turn/interrupt" }>;

type SupportedClientRequestMethod = SupportedClientRequest["method"];
type SupportedClientRequestParams<M extends SupportedClientRequestMethod> = Extract<
  SupportedClientRequest,
  { method: M }
>["params"];

type JsonRpcClient = {
  close: () => Promise<void>;
  notifyInitialized: () => void;
  onNotification: (handler: (notification: JsonRpcNotificationMessage) => void) => () => void;
  request: <M extends SupportedClientRequestMethod>(
    method: M,
    params: SupportedClientRequestParams<M>,
  ) => Promise<unknown>;
};

export function createJsonRpcClient(processHandle: StdioProcessHandle): JsonRpcClient {
  const pendingRequests = new Map<RequestId, PendingRequest>();
  const notificationHandlers = new Set<(notification: JsonRpcNotificationMessage) => void>();
  let nextRequestId = 1;
  let closed = false;

  const rejectPendingRequests = (error: Error): void => {
    for (const request of pendingRequests.values()) {
      request.reject(error);
    }
    pendingRequests.clear();
  };

  processHandle.onLine((line) => {
    handleLine({
      line,
      notificationHandlers,
      pendingRequests,
      processHandle,
      rejectPendingRequests,
    });
  });
  processHandle.onError((error) => {
    rejectPendingRequests(error);
  });
  processHandle.onExit(() => {
    rejectPendingRequests(new Error("Codex app-server process exited unexpectedly."));
  });

  return {
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await processHandle.close();
    },
    notifyInitialized: () => {
      const notification: ClientNotification = {
        method: "initialized",
      };
      processHandle.writeLine(notification);
    },
    onNotification: (handler) => {
      notificationHandlers.add(handler);
      return () => {
        notificationHandlers.delete(handler);
      };
    },
    request: async (method, params) => {
      const id = nextRequestId++;
      const requestMessage = {
        id,
        method,
        params,
      };
      logger.debug("codex.rpc.request.outbound", {
        payload: requestMessage,
      });
      processHandle.writeLine(requestMessage);

      return await new Promise((resolve, reject) => {
        pendingRequests.set(id, { reject, resolve });
      });
    },
  };
}

function handleLine(input: {
  line: string;
  notificationHandlers: Set<(notification: JsonRpcNotificationMessage) => void>;
  pendingRequests: Map<RequestId, PendingRequest>;
  processHandle: StdioProcessHandle;
  rejectPendingRequests: (error: Error) => void;
}): void {
  let message: unknown;
  try {
    message = JSON.parse(input.line);
  } catch {
    return;
  }

  if (isResponse(message)) {
    logger.debug("codex.rpc.response.inbound", {
      payload: message,
    });

    const pendingRequestKey = resolvePendingRequestKey(input.pendingRequests, message.id);
    if (pendingRequestKey === undefined) {
      return;
    }
    const pendingRequest = input.pendingRequests.get(pendingRequestKey);
    if (!pendingRequest) {
      return;
    }
    input.pendingRequests.delete(pendingRequestKey);

    if (message.error) {
      pendingRequest.reject(
        new Error(`app-server error: ${message.error.code} ${message.error.message}`),
      );
      return;
    }
    pendingRequest.resolve(message.result);
    return;
  }

  const serverRequest = parseInboundRequest(message);
  if (serverRequest) {
    logger.debug("codex.rpc.request.inbound", {
      payload: serverRequest,
    });

    void handleServerRequestAsync(serverRequest, input.processHandle).catch((error: unknown) => {
      input.rejectPendingRequests(
        new Error(error instanceof Error ? error.message : "Failed to handle app-server request."),
      );
    });
    return;
  }

  if (isNotification(message)) {
    for (const handler of input.notificationHandlers) {
      handler(message);
    }
  }
}

async function handleServerRequestAsync(
  request: ParsedInboundRequest,
  processHandle: StdioProcessHandle,
): Promise<void> {
  if (request.method === "item/commandExecution/requestApproval") {
    const response: CommandExecutionRequestApprovalResponse = {
      decision: "decline",
    };
    writeRpcResponse(processHandle, {
      id: request.id,
      result: response,
    });
    return;
  }

  if (request.method === "item/fileChange/requestApproval") {
    const response: FileChangeRequestApprovalResponse = {
      decision: "decline",
    };
    writeRpcResponse(processHandle, {
      id: request.id,
      result: response,
    });
    return;
  }

  if (request.method === "item/tool/requestUserInput") {
    const questions = extractQuestions(request.params);
    const response: ToolRequestUserInputResponse = {
      answers: Object.fromEntries(
        questions.map((question) => {
          return [question.id, { answers: [pickDeclineOption(question)] }];
        }),
      ),
    };
    writeRpcResponse(processHandle, {
      id: request.id,
      result: response,
    });
    return;
  }

  writeRpcResponse(processHandle, {
    error: {
      code: -32601,
      message: `Unsupported client-side method: ${request.method}`,
    },
    id: request.id,
  });
}

function writeRpcResponse(
  processHandle: StdioProcessHandle,
  message: JsonRpcResponseMessage,
): void {
  logger.debug("codex.rpc.response.outbound", {
    payload: message,
  });
  processHandle.writeLine(message);
}

export function normalizeThreadStartConfig(
  config: Record<string, unknown>,
): NonNullable<ThreadStartParams["config"]> {
  const normalized: NonNullable<ThreadStartParams["config"]> = {};

  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) {
      continue;
    }
    if (!isJsonValue(value)) {
      throw new Error(`Invalid thread config value for key: ${key}`);
    }
    normalized[key] = value;
  }

  return normalized;
}

export function extractThreadId(result: unknown): string {
  if (!isRecord(result)) {
    throw new Error("thread/start response does not include thread.id");
  }
  const thread = result["thread"];
  if (!isRecord(thread)) {
    throw new Error("thread/start response does not include thread.id");
  }

  const threadId = thread["id"];
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new Error("thread/start response does not include thread.id");
  }

  return threadId;
}

export function extractTurnId(result: unknown): string {
  if (!isRecord(result)) {
    throw new Error("turn/start response does not include turn.id");
  }
  const turn = result["turn"];
  if (!isRecord(turn)) {
    throw new Error("turn/start response does not include turn.id");
  }

  const turnId = turn["id"];
  if (typeof turnId !== "string" || turnId.length === 0) {
    throw new Error("turn/start response does not include turn.id");
  }

  return turnId;
}

function extractQuestions(params: unknown): ToolRequestUserInputQuestion[] {
  if (!isToolRequestUserInputParams(params)) {
    return [];
  }

  return params.questions;
}

function pickDeclineOption(question: ToolRequestUserInputQuestion): string {
  const options = question.options ?? [];
  const declineOption = options.find((option) => {
    const label = option.label.toLowerCase();
    return label.includes("decline") || label.includes("cancel");
  });
  if (declineOption) {
    return declineOption.label;
  }
  if (options[0]) {
    return options[0].label;
  }

  return "";
}

function isToolRequestUserInputParams(value: unknown): value is {
  questions: ToolRequestUserInputQuestion[];
} {
  if (!isRecord(value)) {
    return false;
  }
  const questions = value["questions"];
  return Array.isArray(questions);
}

function parseInboundRequest(message: unknown): ParsedInboundRequest | undefined {
  if (!isRecord(message)) {
    return undefined;
  }

  const id = message["id"];
  const method = message["method"];
  if (!isRequestId(id) || typeof method !== "string") {
    return undefined;
  }

  return {
    id,
    method,
    params: message["params"],
  };
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "number" || typeof value === "string";
}

function isResponse(message: unknown): message is JsonRpcResponseMessage {
  if (!isRecord(message)) {
    return false;
  }
  const id = message["id"];
  if (!isRequestId(id)) {
    return false;
  }

  const method = message["method"];
  if (typeof method === "string") {
    return false;
  }

  const hasResult = "result" in message;
  const hasError = isRpcError(message["error"]);
  return hasResult || hasError;
}

function isRpcError(value: unknown): value is {
  code: number;
  message: string;
} {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value["code"] === "number" && typeof value["message"] === "string";
}

function isNotification(message: unknown): message is JsonRpcNotificationMessage {
  if (!isRecord(message)) {
    return false;
  }
  return typeof message["method"] === "string";
}

function resolvePendingRequestKey(
  pendingRequests: Map<RequestId, PendingRequest>,
  incomingId: RequestId,
): RequestId | undefined {
  if (pendingRequests.has(incomingId)) {
    return incomingId;
  }

  if (typeof incomingId === "string" && incomingId.length > 0) {
    const numericId = Number(incomingId);
    if (Number.isInteger(numericId) && pendingRequests.has(numericId)) {
      return numericId;
    }
  }

  if (typeof incomingId === "number" && pendingRequests.has(String(incomingId))) {
    return String(incomingId);
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }

  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((nestedValue) => {
    return nestedValue === undefined || isJsonValue(nestedValue);
  });
}

export const CLIENT_INFO = {
  name: "luna-chat",
  title: "Luna Chat",
  version: "0.1.0",
};
