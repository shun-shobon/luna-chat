import type { JsonValue } from "../../event/domain/luna-event";

export type HttpEventOutcome =
  | Readonly<{ kind: "response"; status: number; body: JsonValue }>
  | Readonly<{ kind: "no_content" }>
  | Readonly<{ kind: "failed" }>;

type PendingResponse = {
  response?: Readonly<{ status: number; body: JsonValue }>;
  resolve(outcome: HttpEventOutcome): void;
};

export class HttpResponseRegistry {
  readonly #pending = new Map<string, PendingResponse>();

  register(requestId: string): Promise<HttpEventOutcome> {
    if (this.#pending.has(requestId)) throw new Error(`Duplicate HTTP request ID: ${requestId}`);
    return new Promise<HttpEventOutcome>((resolve) => {
      this.#pending.set(requestId, { resolve });
    });
  }

  record(requestId: string, status: number, body: JsonValue): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) throw new Error(`HTTP request is not waiting: ${requestId}`);
    if (pending.response !== undefined)
      throw new Error(`HTTP request already has a response: ${requestId}`);
    pending.response = { status, body };
  }

  complete(requestId: string, succeeded: boolean): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    pending.resolve(
      !succeeded
        ? { kind: "failed" }
        : pending.response === undefined
          ? { kind: "no_content" }
          : { kind: "response", ...pending.response },
    );
  }

  failAll(): void {
    for (const requestId of this.#pending.keys()) this.complete(requestId, false);
  }
}
