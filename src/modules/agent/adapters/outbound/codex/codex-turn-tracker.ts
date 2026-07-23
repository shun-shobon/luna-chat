import { z } from "zod";

import type { ServerNotification } from "../../../../../generated/codex/ServerNotification";
import { parseAgentOutputText } from "../../../domain/agent-output";
import type { AgentTurnResult, ThreadId, TurnId } from "../../../ports/outbound/agent-runtime-port";

import type { JsonRpcNotification, JsonRpcServerRequest } from "./json-rpc-connection";

const turnReferenceSchema = z.looseObject({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
});
const turnStartedSchema = z.looseObject({
  threadId: z.string().min(1),
  turn: z.looseObject({ id: z.string().min(1) }),
});
const turnCompletedSchema = z.looseObject({
  threadId: z.string().min(1),
  turn: z.looseObject({
    error: z.looseObject({ message: z.string() }).nullable(),
    id: z.string().min(1),
    status: z.enum(["completed", "failed", "interrupted", "inProgress"]),
  }),
});
const itemCompletedSchema = z.looseObject({
  item: z.looseObject({ type: z.string() }),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
});
const agentMessageSchema = z.looseObject({
  phase: z.enum(["commentary", "final_answer"]).nullable(),
  text: z.string(),
  type: z.literal("agentMessage"),
});
const errorNotificationSchema = turnReferenceSchema.extend({
  error: z.looseObject({ message: z.string() }),
  willRetry: z.boolean(),
});

const GENERATED_TURN_REFERENCE_NOTIFICATION_METHODS: ServerNotification["method"][] = [
  "item/started",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "rawResponseItem/completed",
  "rawResponse/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "thread/tokenUsage/updated",
  "thread/goal/updated",
  "hook/started",
  "hook/completed",
  "turn/diff/updated",
  "turn/plan/updated",
  "thread/compacted",
  "model/rerouted",
  "model/verification",
  "turn/moderationMetadata",
  "model/safetyBuffering/updated",
];
const TURN_REFERENCE_NOTIFICATION_METHODS: ReadonlySet<string> = new Set(
  GENERATED_TURN_REFERENCE_NOTIFICATION_METHODS,
);

export function isTurnScopedNotificationMethod(method: string): boolean {
  return (
    method === "error" ||
    method === "turn/started" ||
    method === "item/completed" ||
    method === "turn/completed" ||
    TURN_REFERENCE_NOTIFICATION_METHODS.has(method)
  );
}

export class TurnCorrelationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TurnCorrelationError";
  }
}

class UnexpectedUserInputRequestError extends Error {
  public constructor() {
    super("Codex requested interactive user input during an unattended turn.");
    this.name = "UnexpectedUserInputRequestError";
  }
}

export class CodexTurnTracker {
  readonly #completion: Promise<AgentTurnResult>;
  readonly #threadId: ThreadId;
  #finalMessage: string | undefined;
  #forcedFailureMessage: string | undefined;
  #lastErrorMessage: string | undefined;
  #rejectCompletion: (error: Error) => void = () => undefined;
  #resolveCompletion: (result: AgentTurnResult) => void = () => undefined;
  #settled = false;
  #turnId: TurnId | undefined;

  public constructor(threadId: ThreadId) {
    this.#threadId = threadId;
    this.#completion = new Promise((resolve, reject) => {
      this.#resolveCompletion = resolve;
      this.#rejectCompletion = reject;
    });
  }

  public get completion(): Promise<AgentTurnResult> {
    return this.#completion;
  }

  public bindTurnId(turnId: TurnId): void {
    if (turnId.length === 0) {
      throw new TurnCorrelationError("turn/start returned an empty turn id.");
    }
    if (this.#turnId !== undefined && this.#turnId !== turnId) {
      throw new TurnCorrelationError("turn/start response and notification turn ids differ.");
    }
    this.#turnId = turnId;
  }

  public fail(error: Error): void {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    this.#rejectCompletion(error);
  }

  public handleNotification(notification: JsonRpcNotification): boolean {
    switch (notification.method) {
      case "turn/started": {
        const params = turnStartedSchema.parse(notification.params);
        if (params.threadId !== this.#threadId) {
          return false;
        }
        this.#correlateTurn(params.turn.id);
        return true;
      }
      case "item/completed": {
        const params = itemCompletedSchema.parse(notification.params);
        if (params.threadId !== this.#threadId) {
          return false;
        }
        this.#correlateTurn(params.turnId);
        if (params.item.type === "agentMessage") {
          const item = agentMessageSchema.parse(params.item);
          if (item.phase === "final_answer") {
            this.#finalMessage = item.text;
          }
        }
        return true;
      }
      case "error": {
        const params = errorNotificationSchema.parse(notification.params);
        if (params.threadId !== this.#threadId) {
          return false;
        }
        this.#correlateTurn(params.turnId);
        this.#lastErrorMessage = params.error.message;
        return true;
      }
      case "turn/completed": {
        const params = turnCompletedSchema.parse(notification.params);
        if (params.threadId !== this.#threadId) {
          return false;
        }
        this.#correlateTurn(params.turn.id);
        this.#complete(params.turn.status, params.turn.error?.message);
        return true;
      }
      default: {
        if (TURN_REFERENCE_NOTIFICATION_METHODS.has(notification.method)) {
          const params = turnReferenceSchema.parse(notification.params);
          if (params.threadId !== this.#threadId) {
            return false;
          }
          this.#correlateTurn(params.turnId);
          return true;
        }
        return false;
      }
    }
  }

  public handleServerRequest(request: JsonRpcServerRequest): boolean {
    if (request.method !== "item/tool/requestUserInput") {
      return false;
    }
    const params = turnReferenceSchema.parse(request.params);
    if (params.threadId !== this.#threadId) {
      return false;
    }
    this.#correlateTurn(params.turnId);
    const error = new UnexpectedUserInputRequestError();
    this.#forcedFailureMessage = error.message;
    return true;
  }

  #complete(status: "completed" | "failed" | "inProgress" | "interrupted", error?: string): void {
    if (this.#settled) {
      return;
    }
    if (status === "inProgress") {
      throw new TurnCorrelationError("turn/completed carried an inProgress turn.");
    }
    this.#settled = true;
    if (this.#forcedFailureMessage !== undefined) {
      this.#resolveCompletion({
        errorMessage: this.#forcedFailureMessage,
        status: "failed",
      });
      return;
    }
    if (status !== "completed") {
      this.#resolveCompletion({
        ...((error ?? this.#lastErrorMessage) === undefined
          ? {}
          : { errorMessage: error ?? this.#lastErrorMessage }),
        status,
      });
      return;
    }
    if (this.#finalMessage === undefined) {
      this.#resolveCompletion({
        errorMessage: "Completed turn did not emit a final agent message.",
        status: "failed",
      });
      return;
    }
    try {
      this.#resolveCompletion({
        output: parseAgentOutputText(this.#finalMessage),
        status: "completed",
      });
    } catch (error: unknown) {
      this.#resolveCompletion({
        errorMessage: error instanceof Error ? error.message : "Agent output is invalid.",
        status: "failed",
      });
    }
  }

  #correlateTurn(turnId: string): void {
    if (this.#turnId === undefined) {
      this.#turnId = turnId;
      return;
    }
    if (this.#turnId !== turnId) {
      throw new TurnCorrelationError(
        `Notification turn id ${turnId} does not match active turn ${this.#turnId}.`,
      );
    }
  }
}
