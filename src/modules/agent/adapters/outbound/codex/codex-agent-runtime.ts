import type { InitializeParams } from "../../../../../generated/codex/InitializeParams";
import type { ThreadSourceKind } from "../../../../../generated/codex/v2/ThreadSourceKind";
import type { UserInput } from "../../../../../generated/codex/v2/UserInput";
import type {
	AgentRuntimePort,
	AgentThreadInput,
	AgentTurnRequest,
	StartedAgentTurn,
	ThreadId,
	TurnId,
} from "../../../ports/outbound/agent-runtime-port";
import {
	parseEmptyResponse,
	parseInitializeResponse,
	parseModelList,
	parseSteeredTurnId,
	parseThreadId,
	parseThreadList,
	parseTurnId,
} from "./codex-response";
import type { CodexLineHandlers, CodexLineTransport } from "./codex-stdio-process";
import {
	CodexTurnTracker,
	isTurnScopedNotificationMethod,
	parseThreadReference,
	parseTurnReference,
} from "./codex-turn-tracker";
import { JsonRpcConnection, JsonRpcProtocolError } from "./json-rpc-connection";
import type {
	JsonRpcNotification,
	JsonRpcServerRequest,
	RpcEventHandler,
} from "./json-rpc-connection";

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

export type StartCodexAgentRuntimeOptions = {
	onFailure(error: Error): void;
	onRpcEvent?: RpcEventHandler | undefined;
	openTransport: (handlers: CodexLineHandlers) => CodexLineTransport;
	rpcTimeoutMs: number;
	signal: AbortSignal;
};

export class CodexAgentRuntime implements AgentRuntimePort {
	readonly #connection: JsonRpcConnection;
	readonly #managedThreadIds = new Set<ThreadId>();
	readonly #trackers = new Map<ThreadId, CodexTurnTracker>();

	private constructor(options: StartCodexAgentRuntimeOptions) {
		this.#connection = new JsonRpcConnection(options.openTransport, options.rpcTimeoutMs, {
			onEvent: options.onRpcEvent,
			onFatal: (error) => {
				for (const tracker of this.#trackers.values()) {
					tracker.fail(error);
				}
				this.#trackers.clear();
				options.onFailure(error);
			},
			onNotification: (notification) => this.#handleNotification(notification),
			onServerRequest: (request) => this.#handleServerRequest(request),
		});
	}

	public static async start(options: StartCodexAgentRuntimeOptions): Promise<CodexAgentRuntime> {
		const runtime = new CodexAgentRuntime(options);
		const abort = () => {
			void runtime.close();
		};
		options.signal.addEventListener("abort", abort, { once: true });
		try {
			const result = await runtime.#connection.request("initialize", CLIENT_INFO);
			parseResponse(runtime.#connection, () => parseInitializeResponse(result));
			runtime.#connection.notifyInitialized();
			return runtime;
		} catch (error: unknown) {
			await runtime.close();
			throw error;
		} finally {
			options.signal.removeEventListener("abort", abort);
		}
	}

	public async close(): Promise<void> {
		await this.#connection.close();
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

	public async listModels(): ReturnType<AgentRuntimePort["listModels"]> {
		const models: Awaited<ReturnType<AgentRuntimePort["listModels"]>>[number][] = [];
		let cursor: string | null = null;
		do {
			const result: unknown = await this.#connection.request("model/list", {
				includeHidden: false,
				cursor,
			});
			const page: ReturnType<typeof parseModelList> = parseResponse(this.#connection, () =>
				parseModelList(result),
			);
			models.push(...page.data);
			cursor = page.nextCursor;
		} while (cursor != null);
		return models;
	}

	public async listArchivedThreads(
		cursor?: string,
	): ReturnType<AgentRuntimePort["listArchivedThreads"]> {
		const result = await this.#connection.request("thread/list", {
			archived: true,
			cursor,
			sortDirection: "desc",
			sortKey: "updated_at",
			sourceKinds: ALL_THREAD_SOURCE_KINDS,
		});
		return parseResponse(this.#connection, () => parseThreadList(result));
	}

	public async openThread(input: AgentThreadInput): Promise<ThreadId> {
		const result = await this.#connection.request("thread/start", {
			approvalPolicy: "never",
			baseInstructions: input.baseInstructions,
			config: input.config,
			cwd: input.cwd,
			developerInstructions: input.developerInstructions,
			ephemeral: false,
			sandbox: "danger-full-access",
		});
		const threadId = parseResponse(this.#connection, () => parseThreadId(result));
		this.#managedThreadIds.add(threadId);
		return threadId;
	}

	public async startTurn(threadId: ThreadId, request: AgentTurnRequest): Promise<StartedAgentTurn> {
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
				...(request.model === undefined ? {} : { model: request.model }),
				...(request.effort === undefined ? {} : { effort: request.effort }),
				input: [createTextInput(request.input)],
				outputSchema: request.outputSchema,
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
		const tracker = this.#trackers.get(threadId);
		if (tracker === undefined) {
			throw new Error(`Thread ${threadId} does not have an active turn.`);
		}
		tracker.assertSteerable(turnId);
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

	#handleNotification(notification: JsonRpcNotification): void {
		if (!isTurnScopedNotificationMethod(notification.method)) {
			return;
		}
		const threadId = parseThreadReference(notification.params);
		if (!this.#managedThreadIds.has(threadId)) {
			return;
		}
		const tracker = this.#trackers.get(threadId);
		if (tracker === undefined) {
			throw new JsonRpcProtocolError(
				`Codex emitted ${notification.method} for an unknown active turn.`,
			);
		}
		tracker.handleNotification(notification);
	}

	#handleServerRequest(request: JsonRpcServerRequest): void {
		if (request.method !== "item/tool/requestUserInput") {
			this.#connection.respondWithError(
				request.id,
				-32601,
				`Unsupported client-side method: ${request.method}`,
			);
			return;
		}
		const { threadId, turnId } = parseTurnReference(request.params);
		const tracker = this.#trackers.get(threadId);
		if (tracker === undefined) {
			throw new JsonRpcProtocolError("Codex requested user input for an unknown active turn.");
		}
		tracker.markUserInputRequested(turnId);
		this.#connection.respondWithError(
			request.id,
			-32601,
			"Interactive user input is not supported by this client.",
		);
		void this.interruptTurn(threadId, turnId).catch((error: unknown) => {
			this.#connection.fail(
				new JsonRpcProtocolError("Failed to interrupt a turn that requested user input.", {
					cause: error,
				}),
			);
		});
	}

	public async interruptTurn(threadId: ThreadId, turnId: TurnId): Promise<void> {
		const result = await this.#connection.request("turn/interrupt", { threadId, turnId });
		parseResponse(this.#connection, () => parseEmptyResponse(result));
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
