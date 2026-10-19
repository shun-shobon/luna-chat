import { z } from "zod";

import type { ServerNotification } from "../../../../../generated/codex/ServerNotification";
import type { AgentTurnResult, ThreadId, TurnId } from "../../../ports/outbound/agent-runtime-port";
import type { JsonRpcNotification } from "./json-rpc-connection";

const threadReferenceSchema = z.looseObject({
	threadId: z.string().min(1),
});
const turnReferenceSchema = threadReferenceSchema.extend({
	turnId: z.string().min(1),
});
const turnStartedSchema = z.looseObject({
	threadId: z.string().min(1),
	turn: z.looseObject({ id: z.string().min(1) }),
});
const turnCompletedSchema = z.looseObject({
	threadId: z.string().min(1),
	turn: z.looseObject({
		error: z
			.looseObject({ codexErrorInfo: z.unknown().optional(), message: z.string() })
			.nullable(),
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
	// Codex 0.162.0でpartial_answerが追加された。本番のCodexは自動更新され得るため、生成型より先に受け付ける。
	phase: z.enum(["commentary", "partial_answer", "final_answer"]).nullable(),
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

export function parseThreadReference(params: unknown): ThreadId {
	return threadReferenceSchema.parse(params).threadId;
}

export function parseTurnReference(params: unknown): { threadId: ThreadId; turnId: TurnId } {
	return turnReferenceSchema.parse(params);
}

export class TurnCorrelationError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "TurnCorrelationError";
	}
}

export class TurnNotSteerableError extends Error {
	public constructor(threadId: ThreadId, turnId: TurnId) {
		super(`Turn ${turnId} on thread ${threadId} has already emitted its final answer.`);
		this.name = "TurnNotSteerableError";
	}
}

const USER_INPUT_REQUESTED_MESSAGE =
	"Codex requested interactive user input during an unattended turn.";

export class CodexTurnTracker {
	readonly #completion = Promise.withResolvers<AgentTurnResult>();
	readonly #threadId: ThreadId;
	readonly #finalMessages: string[] = [];
	#forcedFailureMessage: string | undefined;
	#lastErrorMessage: string | undefined;
	#settled = false;
	#turnId: TurnId | undefined;

	public constructor(threadId: ThreadId) {
		this.#threadId = threadId;
	}

	public get completion(): Promise<AgentTurnResult> {
		return this.#completion.promise;
	}

	public assertSteerable(turnId: TurnId): void {
		this.#correlateTurn(turnId);
		if (this.#finalMessages.length > 0) {
			throw new TurnNotSteerableError(this.#threadId, turnId);
		}
	}

	public bindTurnId(turnId: TurnId): void {
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
		this.#completion.reject(error);
	}

	/** Handles a turn-scoped notification already routed to this tracker's thread. */
	public handleNotification(notification: JsonRpcNotification): void {
		switch (notification.method) {
			case "turn/started": {
				this.#correlateTurn(turnStartedSchema.parse(notification.params).turn.id);
				return;
			}
			case "item/completed": {
				const params = itemCompletedSchema.parse(notification.params);
				this.#correlateTurn(params.turnId);
				if (params.item.type === "agentMessage") {
					const item = agentMessageSchema.parse(params.item);
					if (item.phase === "final_answer") {
						this.#finalMessages.push(item.text);
					}
				}
				return;
			}
			case "error": {
				const params = errorNotificationSchema.parse(notification.params);
				this.#correlateTurn(params.turnId);
				this.#lastErrorMessage = params.error.message;
				return;
			}
			case "turn/completed": {
				const params = turnCompletedSchema.parse(notification.params);
				this.#correlateTurn(params.turn.id);
				this.#complete(
					params.turn.status,
					params.turn.error?.message,
					isRetryableCodexError(params.turn.error?.codexErrorInfo),
				);
				return;
			}
			default: {
				this.#correlateTurn(turnReferenceSchema.parse(notification.params).turnId);
			}
		}
	}

	public markUserInputRequested(turnId: TurnId): void {
		this.#correlateTurn(turnId);
		this.#forcedFailureMessage = USER_INPUT_REQUESTED_MESSAGE;
	}

	#complete(
		status: "completed" | "failed" | "inProgress" | "interrupted",
		error?: string,
		retryable = false,
	): void {
		if (this.#settled) {
			return;
		}
		if (status === "inProgress") {
			throw new TurnCorrelationError("turn/completed carried an inProgress turn.");
		}
		this.#settled = true;
		if (this.#forcedFailureMessage !== undefined) {
			this.#completion.resolve({
				errorMessage: this.#forcedFailureMessage,
				retryable: false,
				status: "failed",
			});
			return;
		}
		if (status !== "completed") {
			const errorMessage = error ?? this.#lastErrorMessage;
			this.#completion.resolve({
				...(errorMessage === undefined ? {} : { errorMessage }),
				retryable: status === "failed" && retryable,
				status,
			});
			return;
		}
		const [first, ...rest] = this.#finalMessages;
		if (first === undefined) {
			this.#completion.resolve({
				errorMessage: "Completed turn did not emit a final agent message.",
				retryable: false,
				status: "failed",
			});
			return;
		}
		this.#completion.resolve({ outputTexts: [first, ...rest], status: "completed" });
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

const RETRYABLE_CODEX_ERRORS: ReadonlySet<string> = new Set([
	"serverOverloaded",
	"internalServerError",
	"httpConnectionFailed",
	"responseStreamConnectionFailed",
	"responseStreamDisconnected",
	"responseTooManyFailedAttempts",
]);

// CodexErrorInfoは文字列か、HTTPステータスを持つ単一キーのオブジェクトで届く。
function isRetryableCodexError(info: unknown): boolean {
	if (typeof info === "string") return RETRYABLE_CODEX_ERRORS.has(info);
	if (typeof info !== "object" || info == null) return false;
	const keys = Object.keys(info);
	return keys.length === 1 && keys[0] !== undefined && RETRYABLE_CODEX_ERRORS.has(keys[0]);
}
