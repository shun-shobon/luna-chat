import type { ClientNotification } from "../../../../../generated/codex/ClientNotification";
import type { ClientRequest } from "../../../../../generated/codex/ClientRequest";
import type { RequestId } from "../../../../../generated/codex/RequestId";

import type { CodexLineTransport } from "./codex-stdio-process";

type SupportedClientRequest =
  | Extract<ClientRequest, { method: "initialize" }>
  | Extract<ClientRequest, { method: "thread/archive" }>
  | Extract<ClientRequest, { method: "thread/delete" }>
  | Extract<ClientRequest, { method: "thread/list" }>
  | Extract<ClientRequest, { method: "thread/start" }>
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
  timeout: Readonly<{ cancel(): void }>;
};

type RpcEventHandler = (
  event: string,
  context: Readonly<{ requestId?: RequestId }>,
  details?: Readonly<Record<string, unknown>>,
  payload?: unknown,
) => void;

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
  readonly #fatalHandlers = new Set<(error: Error) => void>();
  readonly #notificationHandlers = new Set<(notification: JsonRpcNotification) => void>();
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #rpcTimeoutMs: number;
  readonly #serverRequestHandlers = new Set<(request: JsonRpcServerRequest) => void>();
  readonly #transport: CodexLineTransport;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #fatalError: Error | undefined;
  #nextRequestId = 1;

  public constructor(
    transport: CodexLineTransport,
    rpcTimeoutMs: number,
    private readonly onEvent?: RpcEventHandler,
  ) {
    if (!Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs <= 0) {
      throw new Error("RPC timeout must be a positive safe integer.");
    }
    this.#transport = transport;
    this.#rpcTimeoutMs = rpcTimeoutMs;
    transport.onLine((line) => this.#handleLine(line));
    transport.onFailure((error) => this.fail(error));
  }

  public close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#rejectPending(new Error("Codex JSON-RPC connection was closed."));
    const closePromise = (async () => await this.#transport.close())();
    this.#closePromise = closePromise;
    return closePromise;
  }

  public fail(error: Error): void {
    if (this.#fatalError !== undefined || this.#closed) {
      return;
    }
    this.#fatalError = error;
    this.onEvent?.("agent.rpc_connection_failed", {}, { error });
    this.#rejectPending(error);
    for (const handler of this.#fatalHandlers) {
      handler(error);
    }
  }

  public notifyInitialized(): void {
    this.#assertUsable();
    const notification: ClientNotification = { method: "initialized" };
    this.#transport.writeLine(notification);
  }

  public onFatal(handler: (error: Error) => void): () => void {
    if (this.#fatalError !== undefined) {
      handler(this.#fatalError);
      return () => undefined;
    }
    this.#fatalHandlers.add(handler);
    return () => this.#fatalHandlers.delete(handler);
  }

  public onNotification(handler: (notification: JsonRpcNotification) => void): () => void {
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  public onServerRequest(handler: (request: JsonRpcServerRequest) => void): () => void {
    this.#serverRequestHandlers.add(handler);
    return () => this.#serverRequestHandlers.delete(handler);
  }

  public async request<M extends SupportedClientRequestMethod>(
    method: M,
    params: SupportedClientRequestParams<M>,
  ): Promise<unknown> {
    this.#assertUsable();
    const id = this.#nextRequestId++;
    this.onEvent?.("agent.rpc_requested", { requestId: id }, { method }, params);
    return await new Promise((resolve, reject) => {
      const timeout = scheduleTimeout(() => {
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
    } catch {
      this.fail(new JsonRpcProtocolError("Codex emitted malformed JSON."));
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
      const request = { ...message, id: value["id"] };
      for (const handler of this.#serverRequestHandlers) {
        try {
          handler(request);
        } catch (error: unknown) {
          this.fail(toProtocolError(error, "Failed to handle a Codex server request."));
          return;
        }
      }
      return;
    }

    for (const handler of this.#notificationHandlers) {
      try {
        handler(message);
      } catch (error: unknown) {
        this.fail(toProtocolError(error, "Failed to handle a Codex notification."));
        return;
      }
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
      pending.timeout.cancel();
      this.#pending.delete(value["id"]);
      this.onEvent?.(
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
    pending.timeout.cancel();
    this.#pending.delete(value["id"]);
    this.onEvent?.(
      "agent.rpc_completed",
      { requestId: value["id"] },
      { method: pending.method },
      value["result"],
    );
    pending.resolve(value["result"]);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.timeout.cancel();
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

const MAXIMUM_TIMEOUT_MS = 2_147_483_647;

function scheduleTimeout(callback: () => void, milliseconds: number): Readonly<{ cancel(): void }> {
  let cancelled = false;
  let remaining = milliseconds;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    const chunk = Math.min(remaining, MAXIMUM_TIMEOUT_MS);
    timer = setTimeout(() => {
      remaining -= chunk;
      if (cancelled) return;
      if (remaining > 0) schedule();
      else callback();
    }, chunk);
  };
  schedule();
  return {
    cancel() {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
