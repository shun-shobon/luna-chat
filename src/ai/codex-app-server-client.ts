import { spawn } from "node:child_process";
import * as readline from "node:readline";

import type { AskForApproval } from "./codex-generated/v2/AskForApproval";
import type { CommandExecutionRequestApprovalResponse } from "./codex-generated/v2/CommandExecutionRequestApprovalResponse";
import type { ErrorNotification } from "./codex-generated/v2/ErrorNotification";
import type { FileChangeRequestApprovalResponse } from "./codex-generated/v2/FileChangeRequestApprovalResponse";
import type { ItemCompletedNotification } from "./codex-generated/v2/ItemCompletedNotification";
import type { SandboxMode } from "./codex-generated/v2/SandboxMode";
import type { ThreadStartParams } from "./codex-generated/v2/ThreadStartParams";
import type { ThreadStartResponse } from "./codex-generated/v2/ThreadStartResponse";
import type { ToolRequestUserInputQuestion } from "./codex-generated/v2/ToolRequestUserInputQuestion";
import type { ToolRequestUserInputResponse } from "./codex-generated/v2/ToolRequestUserInputResponse";
import type { TurnCompletedNotification } from "./codex-generated/v2/TurnCompletedNotification";
import type { TurnStartParams } from "./codex-generated/v2/TurnStartParams";

type JsonRpcRequestMessage = {
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcResponseMessage = {
  id: number;
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

type JsonRpcMessage =
  | JsonRpcRequestMessage
  | JsonRpcResponseMessage
  | JsonRpcNotificationMessage
  | Record<string, unknown>;

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
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
  name: "luna-chat",
  title: "Luna Chat",
  version: "0.1.0",
};

export class CodexAppServerClient {
  private readonly child;
  private readonly lineReader;
  private readonly pendingRequests = new Map<number, PendingRequest>();
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
      clientInfo: CLIENT_INFO,
    });
    this.notify("initialized", {});
  }

  async startThread(input: {
    instructions: string;
    developerRolePrompt: string;
    config?: Record<string, unknown>;
  }): Promise<string> {
    const threadStartParams: ThreadStartParams = {
      approvalPolicy: this.options.approvalPolicy as AskForApproval,
      baseInstructions: input.instructions,
      cwd: this.options.cwd,
      developerInstructions: input.developerRolePrompt,
      experimentalRawEvents: false,
      model: this.options.model,
      persistExtendedHistory: false,
      sandbox: this.options.sandbox as SandboxMode,
    };
    if (input.config) {
      threadStartParams.config = input.config as Exclude<ThreadStartParams["config"], undefined>;
    }
    const result = (await this.request("thread/start", threadStartParams)) as ThreadStartResponse;
    const threadId = result.thread?.id;
    if (!threadId) {
      throw new Error("thread/start response does not include thread.id");
    }

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
      await this.request("turn/start", turnStartParams);

      return await waitForTurnCompletion(this, threadId, tracker);
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

  async interruptTurn(threadId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId }).catch(() => {
      // Ignore; interruption is best effort when timing out.
    });
  }

  getTimeoutMs(): number {
    return this.options.timeoutMs;
  }

  private notify(method: string, params?: unknown): void {
    const notification = { method } as JsonRpcNotificationMessage;
    if (params) {
      notification.params = params;
    }
    this.writeLine(notification);
  }

  private onNotification(handler: (notification: JsonRpcNotificationMessage) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    const request = {
      id,
      method,
    } as JsonRpcRequestMessage;
    if (params) {
      request.params = params;
    }
    this.writeLine(request);

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { reject, resolve });
    });
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    if (isResponse(message)) {
      const pendingRequest = this.pendingRequests.get(message.id);
      if (!pendingRequest) {
        return;
      }
      this.pendingRequests.delete(message.id);

      if (message.error) {
        pendingRequest.reject(
          new Error(`app-server error: ${message.error.code} ${message.error.message}`),
        );
        return;
      }
      pendingRequest.resolve(message.result);
      return;
    }

    if (isServerRequest(message)) {
      void this.handleServerRequestAsync(message);
      return;
    }

    if (isNotification(message)) {
      for (const handler of this.notificationHandlers) {
        handler(message);
      }
    }
  }

  private async handleServerRequestAsync(request: JsonRpcRequestMessage): Promise<void> {
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

  private writeLine(message: Record<string, unknown>): void {
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

function handleTurnNotification(
  notification: JsonRpcNotificationMessage,
  tracker: TurnTracker,
): void {
  if (notification.method === "item/agentMessage/delta") {
    const params = notification.params as { delta?: string } | undefined;
    if (typeof params?.delta === "string") {
      tracker.deltaText += params.delta;
    }
    return;
  }

  if (notification.method === "item/completed") {
    const params = notification.params as ItemCompletedNotification;
    if (params.item.type === "agentMessage") {
      tracker.latestAgentMessageText = params.item.text;
      return;
    }
    if (
      params.item.type === "mcpToolCall" &&
      (params.item.status === "completed" ||
        params.item.status === "failed" ||
        params.item.status === "inProgress")
    ) {
      tracker.mcpToolCalls.push({
        arguments: params.item.arguments,
        result: params.item.result,
        server: params.item.server,
        status: params.item.status,
        tool: params.item.tool,
      });
    }
    return;
  }

  if (notification.method === "error") {
    const params = notification.params as ErrorNotification;
    tracker.errorMessage = params.error.message;
    return;
  }

  if (notification.method === "turn/completed") {
    const params = notification.params as TurnCompletedNotification;
    if (
      params.turn.status === "completed" ||
      params.turn.status === "failed" ||
      params.turn.status === "interrupted"
    ) {
      tracker.completedStatus = params.turn.status;
    } else {
      tracker.completedStatus = "failed";
    }

    if (!tracker.errorMessage && params.turn.error?.message) {
      tracker.errorMessage = params.turn.error.message;
    }
  }
}

async function waitForTurnCompletion(
  client: CodexAppServerClient,
  threadId: string,
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

  await client.interruptTurn(threadId);
  return {
    assistantText: tracker.latestAgentMessageText ?? tracker.deltaText.trim(),
    errorMessage: `turn timed out after ${timeoutMs}ms`,
    mcpToolCalls: tracker.mcpToolCalls,
    status: "failed",
  };
}

function extractQuestions(params: unknown): ToolRequestUserInputQuestion[] {
  if (!params || typeof params !== "object") {
    return [];
  }

  const rawQuestions = (params as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions)) {
    return [];
  }

  return rawQuestions.filter((question) => {
    return (
      question &&
      typeof question === "object" &&
      typeof (question as { id?: unknown }).id === "string"
    );
  }) as ToolRequestUserInputQuestion[];
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

function isResponse(message: JsonRpcMessage): message is JsonRpcResponseMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  return (
    "id" in message &&
    typeof (message as { id?: unknown }).id === "number" &&
    ("result" in message || "error" in message)
  );
}

function isServerRequest(message: JsonRpcMessage): message is JsonRpcRequestMessage {
  if (!message || typeof message !== "object") {
    return false;
  }
  return (
    "method" in message &&
    typeof (message as { method?: unknown }).method === "string" &&
    "id" in message &&
    typeof (message as { id?: unknown }).id === "number"
  );
}

function isNotification(message: JsonRpcMessage): message is JsonRpcNotificationMessage {
  if (!message || typeof message !== "object") {
    return false;
  }
  return (
    "method" in message &&
    typeof (message as { method?: unknown }).method === "string" &&
    !("id" in message)
  );
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
