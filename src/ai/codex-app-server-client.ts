import { spawn } from "node:child_process";
import * as readline from "node:readline";

import type { ClientNotification } from "./codex-generated/ClientNotification";
import type { ClientRequest } from "./codex-generated/ClientRequest";
import type { RequestId } from "./codex-generated/RequestId";
import type { JsonValue } from "./codex-generated/serde_json/JsonValue";
import type { AskForApproval } from "./codex-generated/v2/AskForApproval";
import type { CommandExecutionRequestApprovalResponse } from "./codex-generated/v2/CommandExecutionRequestApprovalResponse";
import type { FileChangeRequestApprovalResponse } from "./codex-generated/v2/FileChangeRequestApprovalResponse";
import type { SandboxMode } from "./codex-generated/v2/SandboxMode";
import type { ThreadStartParams } from "./codex-generated/v2/ThreadStartParams";
import type { ToolRequestUserInputOption } from "./codex-generated/v2/ToolRequestUserInputOption";
import type { ToolRequestUserInputParams } from "./codex-generated/v2/ToolRequestUserInputParams";
import type { ToolRequestUserInputQuestion } from "./codex-generated/v2/ToolRequestUserInputQuestion";
import type { ToolRequestUserInputResponse } from "./codex-generated/v2/ToolRequestUserInputResponse";
import type { TurnStartParams } from "./codex-generated/v2/TurnStartParams";

type JsonRpcResponseMessage = {
  id: RequestId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

type JsonRpcNotificationMessage = {
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
  | Extract<ClientRequest, { method: "turn/interrupt" }>;
type SupportedClientRequestMethod = SupportedClientRequest["method"];
type SupportedClientRequestParams<M extends SupportedClientRequestMethod> = Extract<
  SupportedClientRequest,
  { method: M }
>["params"];

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

export type CodexAppServerClientOptions = {
  command: string;
  cwd: string;
  model: string;
  approvalPolicy: string;
  sandbox: string;
  timeoutMs: number;
};

const CLIENT_INFO = {
  name: "umbra",
  title: "Umbra",
  version: "0.1.0",
};

const APPROVAL_POLICIES = [
  "untrusted",
  "on-failure",
  "on-request",
  "never",
] as const satisfies readonly AskForApproval[];

const SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const satisfies readonly SandboxMode[];

export class CodexAppServerClient {
  private readonly child;
  private readonly lineReader;
  private readonly pendingRequests = new Map<RequestId, PendingRequest>();
  private readonly notificationHandlers = new Set<
    (notification: JsonRpcNotificationMessage) => void
  >();
  private nextRequestId = 1;
  private closed = false;

  constructor(private readonly options: CodexAppServerClientOptions) {
    this.child = spawn(this.options.command, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.lineReader = readline.createInterface({
      input: this.child.stdout,
    });

    this.lineReader.on("line", (line) => {
      this.handleLine(line);
    });
    this.child.on("error", (error) => {
      this.rejectPendingRequests(error);
    });
    this.child.on("exit", () => {
      this.rejectPendingRequests(new Error("Codex app-server process exited unexpectedly."));
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      capabilities: null,
      clientInfo: CLIENT_INFO,
    });
    this.notifyInitialized();
  }

  async startThread(input: {
    instructions: string;
    developerRolePrompt: string;
    config?: Record<string, unknown>;
  }): Promise<string> {
    const threadStartParams: ThreadStartParams = {
      approvalPolicy: parseApprovalPolicy(this.options.approvalPolicy),
      baseInstructions: input.instructions,
      cwd: this.options.cwd,
      developerInstructions: input.developerRolePrompt,
      ephemeral: true,
      experimentalRawEvents: false,
      model: this.options.model,
      personality: "friendly",
      persistExtendedHistory: false,
      sandbox: parseSandboxMode(this.options.sandbox),
    };

    if (input.config) {
      threadStartParams.config = normalizeThreadStartConfig(input.config);
    }

    const result = await this.request("thread/start", threadStartParams);
    const threadId = extractThreadId(result);

    return threadId;
  }

  async runTurn(threadId: string, prompt: string): Promise<TurnResult> {
    const tracker = createTurnTracker();
    const unbind = this.onNotification((notification) => {
      handleTurnNotification(notification, tracker);
    });

    try {
      const turnStartParams: TurnStartParams = {
        input: [{ text: prompt, text_elements: [], type: "text" }],
        threadId,
      };
      const turnStartResult = await this.request("turn/start", turnStartParams);
      const turnId = extractTurnId(turnStartResult);

      return await waitForTurnCompletion(this, threadId, turnId, tracker);
    } finally {
      unbind();
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.lineReader.close();
    this.child.kill("SIGTERM");
    setTimeout(() => {
      if (!this.child.killed) {
        this.child.kill("SIGKILL");
      }
    }, 1_000);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const interruptRequest = this.request("turn/interrupt", { threadId, turnId }).catch(() => {
      // Ignore; interruption is best effort when timing out.
    });
    await Promise.race([interruptRequest, wait(500)]);
  }

  getTimeoutMs(): number {
    return this.options.timeoutMs;
  }

  private notifyInitialized(): void {
    const notification: ClientNotification = {
      method: "initialized",
    };
    this.writeLine(notification);
  }

  private onNotification(handler: (notification: JsonRpcNotificationMessage) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  private async request<M extends SupportedClientRequestMethod>(
    method: M,
    params: SupportedClientRequestParams<M>,
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    const request = {
      id,
      method,
      params,
    };
    this.writeLine(request);

    return await new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { reject, resolve });
    });
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (isResponse(message)) {
      const pendingRequestKey = resolvePendingRequestKey(this.pendingRequests, message.id);
      if (pendingRequestKey === undefined) {
        return;
      }
      const pendingRequest = this.pendingRequests.get(pendingRequestKey);
      if (!pendingRequest) {
        return;
      }
      this.pendingRequests.delete(pendingRequestKey);

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
      void this.handleServerRequestAsync(serverRequest);
      return;
    }

    if (isNotification(message)) {
      for (const handler of this.notificationHandlers) {
        handler(message);
      }
    }
  }

  private async handleServerRequestAsync(request: ParsedInboundRequest): Promise<void> {
    if (request.method === "item/commandExecution/requestApproval") {
      const response: CommandExecutionRequestApprovalResponse = {
        decision: "decline",
      };
      this.writeLine({
        id: request.id,
        result: response,
      });
      return;
    }

    if (request.method === "item/fileChange/requestApproval") {
      const response: FileChangeRequestApprovalResponse = {
        decision: "decline",
      };
      this.writeLine({
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
      this.writeLine({
        id: request.id,
        result: response,
      });
      return;
    }

    this.writeLine({
      error: {
        code: -32601,
        message: `Unsupported client-side method: ${request.method}`,
      },
      id: request.id,
    });
  }

  private rejectPendingRequests(error: Error): void {
    for (const request of this.pendingRequests.values()) {
      request.reject(error);
    }
    this.pendingRequests.clear();
  }

  private writeLine(message: object): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

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

function createTurnTracker(): TurnTracker {
  return {
    deltaText: "",
    mcpToolCalls: [],
  };
}

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

function handleTurnNotification(
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

async function waitForTurnCompletion(
  client: CodexAppServerClient,
  threadId: string,
  turnId: string,
  tracker: TurnTracker,
): Promise<TurnResult> {
  const timeoutMs = client.getTimeoutMs();
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    if (tracker.completedStatus) {
      const assistantText = tracker.latestAgentMessageText ?? tracker.deltaText.trim();
      const turnResult: TurnResult = {
        assistantText,
        mcpToolCalls: tracker.mcpToolCalls,
        status: tracker.completedStatus,
      };
      if (tracker.errorMessage) {
        turnResult.errorMessage = tracker.errorMessage;
      }

      return turnResult;
    }

    await wait(10);
  }

  await client.interruptTurn(threadId, turnId);
  return {
    assistantText: tracker.latestAgentMessageText ?? tracker.deltaText.trim(),
    errorMessage: `turn timed out after ${timeoutMs}ms`,
    mcpToolCalls: tracker.mcpToolCalls,
    status: "failed",
  };
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

function parseApprovalPolicy(value: unknown): AskForApproval {
  if (isApprovalPolicy(value)) {
    return value;
  }
  throw new Error(`Invalid approvalPolicy: ${String(value)}`);
}

function parseSandboxMode(value: unknown): SandboxMode {
  if (isSandboxMode(value)) {
    return value;
  }
  throw new Error(`Invalid sandbox mode: ${String(value)}`);
}

function normalizeThreadStartConfig(
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

function extractThreadId(result: unknown): string {
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

function extractTurnId(result: unknown): string {
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
  if (typeof itemType !== "string") {
    return undefined;
  }

  if (itemType === "agentMessage") {
    const text = item["text"];
    if (typeof text !== "string") {
      return undefined;
    }

    return {
      kind: "agentMessage",
      text,
    };
  }

  if (itemType === "mcpToolCall") {
    const server = item["server"];
    const status = item["status"];
    const tool = item["tool"];
    if (typeof server !== "string" || !isMcpToolCallStatus(status) || typeof tool !== "string") {
      return undefined;
    }

    return {
      arguments: item["arguments"],
      kind: "mcpToolCall",
      result: item["result"],
      server,
      status,
      tool,
    };
  }

  return {
    kind: "other",
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

function parseTurnCompletedParams(params: unknown):
  | {
      status: string;
      errorMessage?: string;
    }
  | undefined {
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

  const error = turn["error"];
  let errorMessage: string | undefined;
  if (isRecord(error)) {
    const message = error["message"];
    if (typeof message === "string") {
      errorMessage = message;
    }
  }

  if (errorMessage) {
    return {
      errorMessage,
      status,
    };
  }

  return {
    status,
  };
}

function isToolRequestUserInputParams(value: unknown): value is ToolRequestUserInputParams {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value["threadId"] !== "string" ||
    typeof value["turnId"] !== "string" ||
    typeof value["itemId"] !== "string"
  ) {
    return false;
  }

  const questions = value["questions"];
  return Array.isArray(questions) && questions.every(isToolRequestUserInputQuestion);
}

function isToolRequestUserInputQuestion(value: unknown): value is ToolRequestUserInputQuestion {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value["id"] !== "string" ||
    typeof value["header"] !== "string" ||
    typeof value["question"] !== "string" ||
    typeof value["isOther"] !== "boolean" ||
    typeof value["isSecret"] !== "boolean"
  ) {
    return false;
  }

  const options = value["options"];
  return (
    options === null || (Array.isArray(options) && options.every(isToolRequestUserInputOption))
  );
}

function isToolRequestUserInputOption(value: unknown): value is ToolRequestUserInputOption {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value["description"] === "string" && typeof value["label"] === "string";
}

function isMcpToolCallStatus(value: unknown): value is "completed" | "failed" | "inProgress" {
  return value === "completed" || value === "failed" || value === "inProgress";
}

function isResponse(message: unknown): message is JsonRpcResponseMessage {
  if (!isRecord(message)) {
    return false;
  }

  if (!isRequestId(message["id"])) {
    return false;
  }

  if (!("result" in message) && !("error" in message)) {
    return false;
  }

  if ("error" in message && message["error"] !== undefined && !isJsonRpcError(message["error"])) {
    return false;
  }

  return true;
}

function parseInboundRequest(message: unknown): ParsedInboundRequest | undefined {
  if (!isRecord(message)) {
    return undefined;
  }

  const id = message["id"];
  if (!isRequestId(id)) {
    return undefined;
  }

  const method = message["method"];
  if (typeof method !== "string") {
    return undefined;
  }

  return {
    id,
    method,
    params: message["params"],
  };
}

function isNotification(message: unknown): message is JsonRpcNotificationMessage {
  if (!isRecord(message)) {
    return false;
  }

  return typeof message["method"] === "string" && !("id" in message);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "number" || typeof value === "string";
}

function isJsonRpcError(value: unknown): value is { code: number; message: string } {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value["code"] === "number" && typeof value["message"] === "string";
}

function isApprovalPolicy(value: unknown): value is AskForApproval {
  return APPROVAL_POLICIES.some((policy) => policy === value);
}

function isSandboxMode(value: unknown): value is SandboxMode {
  return SANDBOX_MODES.some((mode) => mode === value);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolvePendingRequestKey(
  pendingRequests: Map<RequestId, PendingRequest>,
  id: RequestId,
): RequestId | undefined {
  if (pendingRequests.has(id)) {
    return id;
  }

  if (typeof id === "string" && isIntegerString(id)) {
    const numericId = Number(id);
    if (pendingRequests.has(numericId)) {
      return numericId;
    }
  }

  if (typeof id === "number") {
    const stringId = String(id);
    if (pendingRequests.has(stringId)) {
      return stringId;
    }
  }

  return undefined;
}

function isIntegerString(value: string): boolean {
  return /^-?[0-9]+$/.test(value);
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
