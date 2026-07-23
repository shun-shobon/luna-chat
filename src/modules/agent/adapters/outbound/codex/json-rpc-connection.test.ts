import { describe, expect, it, vi } from "vitest";

import type { CodexLineTransport } from "./codex-stdio-process";
import { JsonRpcConnection, JsonRpcProtocolError, RpcTimeoutError } from "./json-rpc-connection";

class FakeTransport implements CodexLineTransport {
  readonly writes: object[] = [];
  readonly #failureHandlers = new Set<(error: Error) => void>();
  readonly #lineHandlers = new Set<(line: string) => void>();

  public constructor(
    private readonly closeOperation: () => Promise<void> = async () => undefined,
  ) {}

  public async close(): Promise<void> {
    await this.closeOperation();
  }

  public emitFailure(error: Error): void {
    for (const handler of this.#failureHandlers) {
      handler(error);
    }
  }

  public emitLine(line: string): void {
    for (const handler of this.#lineHandlers) {
      handler(line);
    }
  }

  public onFailure(handler: (error: Error) => void): () => void {
    this.#failureHandlers.add(handler);
    return () => this.#failureHandlers.delete(handler);
  }

  public onLine(handler: (line: string) => void): () => void {
    this.#lineHandlers.add(handler);
    return () => this.#lineHandlers.delete(handler);
  }

  public writeLine(value: object): void {
    this.writes.push(value);
  }
}

describe("JsonRpcConnection", () => {
  it("RPC timeout を接続全体の fatal とし、全 pending request を失敗させる", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const connection = new JsonRpcConnection(transport, 1_000);
    const fatalErrors: Error[] = [];
    connection.onFatal((error) => fatalErrors.push(error));

    const first = connection.request("thread/archive", { threadId: "thread-1" });
    const second = connection.request("thread/delete", { threadId: "thread-2" });
    const firstRejection = expect(first).rejects.toBeInstanceOf(RpcTimeoutError);
    const secondRejection = expect(second).rejects.toBeInstanceOf(RpcTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);

    await firstRejection;
    await secondRejection;
    expect(fatalErrors).toHaveLength(1);
    expect(() => connection.notifyInitialized()).toThrow(RpcTimeoutError);
    vi.useRealTimers();
  });

  it("不正 JSON を protocol fatal として扱う", async () => {
    const transport = new FakeTransport();
    const connection = new JsonRpcConnection(transport, 1_000);
    const request = connection.request("thread/archive", { threadId: "thread-1" });

    transport.emitLine("not-json");

    await expect(request).rejects.toBeInstanceOf(JsonRpcProtocolError);
  });

  it("未知の response id を protocol fatal として扱う", () => {
    const transport = new FakeTransport();
    const connection = new JsonRpcConnection(transport, 1_000);
    const errors: Error[] = [];
    connection.onFatal((error) => errors.push(error));

    transport.emitLine('{"id":999,"result":{}}');

    expect(errors[0]).toBeInstanceOf(JsonRpcProtocolError);
  });

  it("不正な error response でも対応 request を必ず失敗させる", async () => {
    const transport = new FakeTransport();
    const connection = new JsonRpcConnection(transport, 1_000);
    const request = connection.request("thread/archive", { threadId: "thread-1" });

    transport.emitLine('{"id":1,"error":{"code":"invalid","message":"failed"}}');

    await expect(request).rejects.toBeInstanceOf(JsonRpcProtocolError);
  });

  it("response の result を対応する request だけに返す", async () => {
    const transport = new FakeTransport();
    const connection = new JsonRpcConnection(transport, 1_000);
    const request = connection.request("thread/archive", { threadId: "thread-1" });

    transport.emitLine('{"id":1,"result":{}}');

    await expect(request).resolves.toEqual({});
    expect(transport.writes).toEqual([
      { id: 1, method: "thread/archive", params: { threadId: "thread-1" } },
    ]);
  });

  it("Node上限を超えるRPC timeoutを1msへ短縮しない", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const connection = new JsonRpcConnection(transport, 2_147_483_648);
    const request = connection.request("thread/archive", { threadId: "thread-1" });

    await vi.advanceTimersByTimeAsync(1);
    transport.emitLine('{"id":1,"result":{}}');

    await expect(request).resolves.toEqual({});
    vi.useRealTimers();
  });

  it("並行closeが同じtransport cleanup完了を待つ", async () => {
    const closing = deferred<void>();
    const closeOperation = vi.fn(async () => await closing.promise);
    const connection = new JsonRpcConnection(new FakeTransport(closeOperation), 1_000);

    const first = connection.close();
    const second = connection.close();
    expect(closeOperation).toHaveBeenCalledOnce();
    closing.resolve(undefined);

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("deferred is not initialized");
      resolvePromise(value);
    },
  };
}
