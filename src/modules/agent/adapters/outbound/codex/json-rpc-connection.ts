import type { ClientNotification } from "../../../../../generated/codex/ClientNotification";
import type { ClientRequest } from "../../../../../generated/codex/ClientRequest";
import type { RequestId } from "../../../../../generated/codex/RequestId";
import type { CodexLineHandlers, CodexLineTransport } from "./codex-stdio-process";

type SupportedClientRequest =
	| Extract<ClientRequest, { method: "initialize" }>
	| Extract<ClientRequest, { method: "thread/archive" }>
	| Extract<ClientRequest, { method: "thread/delete" }>
	| Extract<ClientRequest, { method: "thread/list" }>
	| Extract<ClientRequest, { method: "thread/start" }>
	| Extract<ClientRequest, { method: "model/list" }>
	| Extract<ClientRequest, { method: "turn/interrupt" }>
	| Extract<ClientRequest, { method: "turn/start" }>
	| Extract<ClientRequest, { method: "turn/steer" }>;

type SupportedClientRequestMethod = SupportedClientRequest["method"];
type SupportedClientRequestParams<M extends SupportedClientRequestMethod> = Extract<
	SupportedClientRequest,
	{ method: M }
>["params"];

export type JsonRpcNotification = {
	method: string;
	params: unknown;
};

export type JsonRpcServerRequest = JsonRpcNotification & {
	id: RequestId;
};

type PendingRequest = {
	method: SupportedClientRequestMethod;
	reject: (error: Error) => void;
	resolve: (result: unknown) => void;
	timeout: NodeJS.Timeout;
};

export type RpcEventHandler = (
	event: string,
	context: Readonly<{ requestId?: RequestId }>,
	details?: Readonly<Record<string, unknown>>,
	payload?: unknown,
) => void;

type JsonRpcConnectionHandlers = {
	onEvent?: RpcEventHandler | undefined;
	onFatal(error: Error): void;
	onNotification(notification: JsonRpcNotification): void;
	onServerRequest(request: JsonRpcServerRequest): void;
};

export class RpcTimeoutError extends Error {
	public constructor(method: string, timeoutMs: number) {
		super(`Codex RPC ${method} timed out after ${String(timeoutMs)} ms.`);
		this.name = "RpcTimeoutError";
	}
}

export class JsonRpcProtocolError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "JsonRpcProtocolError";
	}
}

export class JsonRpcConnection {
	readonly #handlers: JsonRpcConnectionHandlers;
	readonly #pending = new Map<RequestId, PendingRequest>();
	readonly #rpcTimeoutMs: number;
	readonly #transport: CodexLineTransport;
	#closePromise: Promise<void> | undefined;
	#closed = false;
	#fatalError: Error | undefined;
	#nextRequestId = 1;

	public constructor(
		openTransport: (handlers: CodexLineHandlers) => CodexLineTransport,
		rpcTimeoutMs: number,
		handlers: JsonRpcConnectionHandlers,
	) {
		this.#handlers = handlers;
		this.#rpcTimeoutMs = rpcTimeoutMs;
		this.#transport = openTransport({
			onFailure: (error) => this.fail(error),
			onLine: (line) => this.#handleLine(line),
		});
	}

	public close(): Promise<void> {
		if (this.#closePromise !== undefined) return this.#closePromise;
		this.#closed = true;
		this.#rejectPending(new Error("Codex JSON-RPC connection was closed."));
		this.#closePromise = this.#transport.close();
		return this.#closePromise;
	}

	public fail(error: Error): void {
		if (this.#fatalError !== undefined || this.#closed) {
			return;
		}
		this.#fatalError = error;
		this.#handlers.onEvent?.("agent.rpc_connection_failed", {}, { error });
		this.#rejectPending(error);
		this.#handlers.onFatal(error);
	}

	public notifyInitialized(): void {
		this.#assertUsable();
		const notification: ClientNotification = { method: "initialized" };
		this.#transport.writeLine(notification);
	}

	public async request<M extends SupportedClientRequestMethod>(
		method: M,
		params: SupportedClientRequestParams<M>,
	): Promise<unknown> {
		this.#assertUsable();
		const id = this.#nextRequestId++;
		this.#handlers.onEvent?.("agent.rpc_requested", { requestId: id }, { method }, params);
		return await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				const error = new RpcTimeoutError(method, this.#rpcTimeoutMs);
				this.fail(error);
			}, this.#rpcTimeoutMs);
			this.#pending.set(id, { method, reject, resolve, timeout });

			try {
				this.#transport.writeLine({ id, method, params });
			} catch (error: unknown) {
				this.fail(toError(error, "Failed to write a Codex RPC request."));
			}
		});
	}

	public respondWithError(id: RequestId, code: number, message: string): void {
		this.#assertUsable();
		this.#transport.writeLine({ error: { code, message }, id });
	}

	#assertUsable(): void {
		if (this.#fatalError !== undefined) {
			throw this.#fatalError;
		}
		if (this.#closed) {
			throw new Error("Codex JSON-RPC connection is closed.");
		}
	}

	#handleLine(line: string): void {
		if (this.#fatalError !== undefined || this.#closed) {
			return;
		}

		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch (error: unknown) {
			this.fail(
				new JsonRpcProtocolError(
					`Codex emitted malformed JSON (line length ${String(line.length)}).`,
					{ cause: error },
				),
			);
			return;
		}

		if (!isRecord(value)) {
			this.fail(new JsonRpcProtocolError("Codex emitted a non-object JSON-RPC message."));
			return;
		}

		if ("method" in value) {
			this.#handleMethodMessage(value);
			return;
		}

		this.#handleResponse(value);
	}

	#handleMethodMessage(value: Record<string, unknown>): void {
		if (typeof value["method"] !== "string" || !("params" in value)) {
			this.fail(new JsonRpcProtocolError("Codex emitted an invalid method message."));
			return;
		}
		const message = { method: value["method"], params: value["params"] };

		if ("id" in value) {
			if (!isRequestId(value["id"])) {
				this.fail(new JsonRpcProtocolError("Codex emitted a server request with an invalid id."));
				return;
			}
			try {
				this.#handlers.onServerRequest({ ...message, id: value["id"] });
			} catch (error: unknown) {
				this.fail(toProtocolError(error, "Failed to handle a Codex server request."));
			}
			return;
		}

		try {
			this.#handlers.onNotification(message);
		} catch (error: unknown) {
			this.fail(toProtocolError(error, "Failed to handle a Codex notification."));
		}
	}

	#handleResponse(value: Record<string, unknown>): void {
		if (!isRequestId(value["id"])) {
			this.fail(new JsonRpcProtocolError("Codex emitted a response with an invalid id."));
			return;
		}

		const pending = this.#pending.get(value["id"]);
		if (pending === undefined) {
			this.fail(new JsonRpcProtocolError("Codex emitted a response for an unknown request id."));
			return;
		}

		const hasResult = "result" in value;
		const hasError = "error" in value;
		if (hasResult === hasError) {
			this.fail(new JsonRpcProtocolError("Codex emitted an invalid response envelope."));
			return;
		}

		if (hasError) {
			const error = value["error"];
			if (
				!isRecord(error) ||
				typeof error["code"] !== "number" ||
				typeof error["message"] !== "string"
			) {
				this.fail(new JsonRpcProtocolError("Codex emitted an invalid RPC error response."));
				return;
			}
			clearTimeout(pending.timeout);
			this.#pending.delete(value["id"]);
			this.#handlers.onEvent?.(
				"agent.rpc_failed",
				{ requestId: value["id"] },
				{
					error,
					method: pending.method,
				},
			);
			pending.reject(new Error(`Codex RPC error ${String(error["code"])}: ${error["message"]}`));
			return;
		}
		clearTimeout(pending.timeout);
		this.#pending.delete(value["id"]);
		this.#handlers.onEvent?.(
			"agent.rpc_completed",
			{ requestId: value["id"] },
			{ method: pending.method },
			value["result"],
		);
		pending.resolve(value["result"]);
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
	return typeof value === "string" || typeof value === "number";
}

function toError(error: unknown, fallbackMessage: string): Error {
	return error instanceof Error ? error : new Error(fallbackMessage);
}

function toProtocolError(error: unknown, fallbackMessage: string): JsonRpcProtocolError {
	return new JsonRpcProtocolError(error instanceof Error ? error.message : fallbackMessage, {
		cause: error,
	});
}
