import { describe, expect, it, vi } from "vitest";

import type { CodexLineHandlers, CodexLineTransport } from "./codex-stdio-process";
import { JsonRpcConnection, JsonRpcProtocolError, RpcTimeoutError } from "./json-rpc-connection";

class FakeTransport implements CodexLineTransport {
	readonly writes: object[] = [];
	#handlers: CodexLineHandlers | undefined;

	public constructor(
		private readonly closeOperation: () => Promise<void> = async () => undefined,
	) {}

	public readonly open = (handlers: CodexLineHandlers): CodexLineTransport => {
		this.#handlers = handlers;
		return this;
	};

	public async close(): Promise<void> {
		await this.closeOperation();
	}

	public emitLine(line: string): void {
		this.#handlers?.onLine(line);
	}

	public writeLine(value: object): void {
		this.writes.push(value);
	}
}

function createConnection(
	transport: FakeTransport,
	onFatal: (error: Error) => void = () => undefined,
): JsonRpcConnection {
	return new JsonRpcConnection(transport.open, 1_000, {
		onFatal,
		onNotification: () => undefined,
		onServerRequest: () => undefined,
	});
}

describe("JsonRpcConnection", () => {
	it("RPC timeout を接続全体の fatal とし、全 pending request を失敗させる", async () => {
		vi.useFakeTimers();
		const transport = new FakeTransport();
		const fatalErrors: Error[] = [];
		const connection = createConnection(transport, (error) => fatalErrors.push(error));

		const first = connection.request("thread/archive", { threadId: "thread-1" });
		const second = connection.request("thread/delete", { threadId: "thread-2" });
		await Promise.all([
			expect(first).rejects.toBeInstanceOf(RpcTimeoutError),
			expect(second).rejects.toBeInstanceOf(RpcTimeoutError),
			vi.advanceTimersByTimeAsync(1_000),
		]);
		expect(fatalErrors).toHaveLength(1);
		expect(() => connection.notifyInitialized()).toThrow(RpcTimeoutError);
		vi.useRealTimers();
	});

	it("不正 JSON を protocol fatal として扱う", async () => {
		const transport = new FakeTransport();
		const connection = createConnection(transport);
		const request = connection.request("thread/archive", { threadId: "thread-1" });

		transport.emitLine("not-json");

		await expect(request).rejects.toBeInstanceOf(JsonRpcProtocolError);
	});

	it("未知の response id を protocol fatal として扱う", () => {
		const transport = new FakeTransport();
		const errors: Error[] = [];
		createConnection(transport, (error) => errors.push(error));

		transport.emitLine('{"id":999,"result":{}}');

		expect(errors[0]).toBeInstanceOf(JsonRpcProtocolError);
	});

	it("不正な error response でも対応 request を必ず失敗させる", async () => {
		const transport = new FakeTransport();
		const connection = createConnection(transport);
		const request = connection.request("thread/archive", { threadId: "thread-1" });

		transport.emitLine('{"id":1,"error":{"code":"invalid","message":"failed"}}');

		await expect(request).rejects.toBeInstanceOf(JsonRpcProtocolError);
	});

	it("response の result を対応する request だけに返す", async () => {
		const transport = new FakeTransport();
		const connection = createConnection(transport);
		const request = connection.request("thread/archive", { threadId: "thread-1" });

		transport.emitLine('{"id":1,"result":{}}');

		await expect(request).resolves.toEqual({});
		expect(transport.writes).toEqual([
			{ id: 1, method: "thread/archive", params: { threadId: "thread-1" } },
		]);
	});

	it("並行closeが同じtransport cleanup完了を待つ", async () => {
		const closing = deferred<void>();
		const closeOperation = vi.fn(async () => await closing.promise);
		const connection = createConnection(new FakeTransport(closeOperation));

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
