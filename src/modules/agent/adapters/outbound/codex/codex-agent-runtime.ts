import type { InitializeParams } from "../../../../../generated/codex/InitializeParams";
import type { ThreadSourceKind } from "../../../../../generated/codex/v2/ThreadSourceKind";
import type { UserInput } from "../../../../../generated/codex/v2/UserInput";
import { AGENT_OUTPUT_JSON_SCHEMA } from "../../../domain/agent-output";
import {
  type AgentRuntimePort,
  type StartedAgentTurn,
  type ThreadId,
  type TurnId,
} from "../../../ports/outbound/agent-runtime-port";

import {
  parseEmptyResponse,
  parseInitializeResponse,
  parseSteeredTurnId,
  parseThreadId,
  parseThreadList,
  parseTurnId,
} from "./codex-response";
import {
  CodexTurnTracker,
  isTurnScopedNotificationMethod,
  parseTurnScopedNotificationThreadId,
} from "./codex-turn-tracker";
import { JsonRpcConnection, JsonRpcProtocolError } from "./json-rpc-connection";
import { parseJsonConfig, parseJsonValue } from "./json-value";

const ALL_THREAD_SOURCE_KINDS: ThreadSourceKind[] = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

const CLIENT_INFO: InitializeParams = {
  capabilities: null,
  clientInfo: {
    name: "luna-chat",
    title: "Luna Chat",
    version: "0.1.0",
  },
};

export class CodexAgentRuntime implements AgentRuntimePort {
  readonly #connection: JsonRpcConnection;
  readonly #managedThreadIds = new Set<ThreadId>();
  readonly #trackers = new Map<ThreadId, CodexTurnTracker>();

  private constructor(connection: JsonRpcConnection) {
    this.#connection = connection;
    connection.onNotification((notification) => {
      const notificationThreadId = parseTurnScopedNotificationThreadId(notification);
      if (notificationThreadId !== undefined && !this.#managedThreadIds.has(notificationThreadId)) {
        return;
      }
      for (const tracker of this.#trackers.values()) {
        if (tracker.handleNotification(notification)) {
          return;
        }
      }
      if (isTurnScopedNotificationMethod(notification.method)) {
        throw new JsonRpcProtocolError(
          `Codex emitted ${notification.method} for an unknown active turn.`,
        );
      }
    });
    connection.onServerRequest((request) => {
      for (const tracker of this.#trackers.values()) {
        if (tracker.handleServerRequest(request)) {
          connection.respondWithError(
            request.id,
            -32601,
            "Interactive user input is not supported by this client.",
          );
          const params = request.params;
          if (
            typeof params !== "object" ||
            params === null ||
            !("threadId" in params) ||
            !("turnId" in params) ||
            typeof params.threadId !== "string" ||
            typeof params.turnId !== "string"
          ) {
            throw new JsonRpcProtocolError("Codex user-input request omitted its turn reference.");
          }
          void this.interruptTurn(params.threadId, params.turnId).catch((error: unknown) => {
            connection.fail(
              new JsonRpcProtocolError("Failed to interrupt a turn that requested user input.", {
                cause: error,
              }),
            );
          });
          return;
        }
      }
      if (request.method === "item/tool/requestUserInput") {
        throw new JsonRpcProtocolError("Codex requested user input for an unknown active turn.");
      }
      connection.respondWithError(
        request.id,
        -32601,
        `Unsupported client-side method: ${request.method}`,
      );
    });
    connection.onFatal((error) => {
      for (const tracker of this.#trackers.values()) {
        tracker.fail(error);
      }
      this.#trackers.clear();
    });
  }

  public static async initialize(connection: JsonRpcConnection): Promise<CodexAgentRuntime> {
    const result = await connection.request("initialize", CLIENT_INFO);
    parseResponse(connection, () => parseInitializeResponse(result));
    connection.notifyInitialized();
    return new CodexAgentRuntime(connection);
  }

  public async archiveThread(threadId: ThreadId): Promise<void> {
    try {
      const result = await this.#connection.request("thread/archive", { threadId });
      parseResponse(this.#connection, () => parseEmptyResponse(result));
    } finally {
      this.#managedThreadIds.delete(threadId);
    }
  }

  public async deleteThread(threadId: ThreadId): Promise<void> {
    const result = await this.#connection.request("thread/delete", { threadId });
    parseResponse(this.#connection, () => parseEmptyResponse(result));
  }

  public async interruptTurn(threadId: ThreadId, turnId: TurnId): Promise<void> {
    const result = await this.#connection.request("turn/interrupt", { threadId, turnId });
    parseResponse(this.#connection, () => parseEmptyResponse(result));
  }

  public async listThreads(input?: {
    archived?: boolean;
    cursor?: string;
    limit?: number;
  }): ReturnType<AgentRuntimePort["listThreads"]> {
    const archived = input?.archived ?? false;
    const result = await this.#connection.request("thread/list", {
      archived,
      cursor: input?.cursor,
      limit: input?.limit,
      sortDirection: "desc",
      sortKey: "updated_at",
      sourceKinds: ALL_THREAD_SOURCE_KINDS,
    });
    return parseResponse(this.#connection, () => parseThreadList(result, archived));
  }

  public async openThread(input: {
    baseInstructions: string;
    config: Record<string, unknown>;
    cwd: string;
    developerInstructions: string;
  }): Promise<ThreadId> {
    const result = await this.#connection.request("thread/start", {
      approvalPolicy: "never",
      baseInstructions: input.baseInstructions,
      config: parseJsonConfig(input.config),
      cwd: input.cwd,
      developerInstructions: input.developerInstructions,
      ephemeral: false,
      sandbox: "danger-full-access",
    });
    const threadId = parseResponse(this.#connection, () => parseThreadId(result));
    this.#managedThreadIds.add(threadId);
    return threadId;
  }

  public async startTurn(threadId: ThreadId, input: string): Promise<StartedAgentTurn> {
    if (this.#trackers.has(threadId)) {
      throw new Error(`Thread ${threadId} already has an active turn.`);
    }
    const tracker = new CodexTurnTracker(threadId);
    this.#managedThreadIds.add(threadId);
    this.#trackers.set(threadId, tracker);
    // A connection failure can occur before turn/start returns; mark that internal
    // completion rejection as observed until ownership is returned to the caller.
    void tracker.completion.catch(() => undefined);

    try {
      const result = await this.#connection.request("turn/start", {
        input: [createTextInput(input)],
        outputSchema: parseJsonValue(AGENT_OUTPUT_JSON_SCHEMA, "agent output schema"),
        threadId,
      });
      const turnId = parseResponse(this.#connection, () => parseTurnId(result));
      parseResponse(this.#connection, () => tracker.bindTurnId(turnId));
      const completion = tracker.completion.finally(() => {
        if (this.#trackers.get(threadId) === tracker) {
          this.#trackers.delete(threadId);
        }
      });
      return { completion, turnId };
    } catch (error: unknown) {
      if (this.#trackers.get(threadId) === tracker) {
        this.#trackers.delete(threadId);
      }
      throw error;
    }
  }

  public async steerTurn(threadId: ThreadId, turnId: TurnId, input: string): Promise<void> {
    const result = await this.#connection.request("turn/steer", {
      expectedTurnId: turnId,
      input: [createTextInput(input)],
      threadId,
    });
    const steeredTurnId = parseResponse(this.#connection, () => parseSteeredTurnId(result));
    if (steeredTurnId !== turnId) {
      const error = new JsonRpcProtocolError(
        `turn/steer returned ${steeredTurnId} instead of expected turn ${turnId}.`,
      );
      this.#connection.fail(error);
      throw error;
    }
  }
}

function createTextInput(text: string): UserInput {
  return { text, text_elements: [], type: "text" };
}

function parseResponse<T>(connection: JsonRpcConnection, parser: () => T): T {
  try {
    return parser();
  } catch (error: unknown) {
    const protocolError = new JsonRpcProtocolError(
      error instanceof Error ? error.message : "Codex emitted an invalid RPC response.",
    );
    connection.fail(protocolError);
    throw protocolError;
  }
}
