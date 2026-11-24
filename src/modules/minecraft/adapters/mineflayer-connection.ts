import { Worker } from "node:worker_threads";

import type { z } from "zod";

import type {
	ActionOutcome,
	ConnectionListener,
	MinecraftConnection,
	MinecraftConnector,
} from "../ports/minecraft-connection-port";
import { responseValueSchemas, workerMessageSchema } from "./mineflayer-protocol";
import type { WorkerRequest } from "./mineflayer-protocol";

// 接続・切断の手続きがこれより長くかかったら、ワーカーを止めて失敗にする。
const CONNECT_TIMEOUT_MS = 30_000;
// ワーカーの close は bot.quit の後 'end' を最大5秒待つため、それより長く待つ。
const CLOSE_TIMEOUT_MS = 8_000;
// 観測・アイテム名の確認・エージェントの行動の候補の列挙に待つ上限。固まったワーカーで判断のループを止めないため。
const QUERY_TIMEOUT_MS = 10_000;
// 行動を中断してから、ワーカーが入力を離して interrupted を返すまで待つ上限。
const ABORT_GRACE_MS = 5_000;

// Node の Worker のうち、使う部分。テストでは偽物に差し替える。
export interface WorkerLike {
	send(message: WorkerRequest): void;
	onMessage(listener: (message: unknown) => void): void;
	onError(listener: (error: Error) => void): void;
	onExit(listener: (code: number) => void): void;
	terminate(): Promise<number>;
}

type RequestBody = WorkerRequest extends infer Request
	? Request extends { id: number }
		? Omit<Request, "id">
		: never
	: never;
type Pending = Readonly<{
	resolve(value: unknown): void;
	reject(error: Error): void;
}>;

// tsdown はワーカーを dist/minecraft-worker.mjs に出す。tsx で動かす開発時とテストでは、ソースの .ts を tsx で読む。
export function spawnMineflayerWorker(): WorkerLike {
	const worker = import.meta.url.endsWith(".ts")
		? new Worker(new URL("./mineflayer-worker.ts", import.meta.url), {
				execArgv: ["--import", "tsx"],
			})
		: new Worker(new URL("./minecraft-worker.mjs", import.meta.url));
	return {
		// oxlint-disable-next-line unicorn/require-post-message-target-origin -- window ではなく worker_threads の Worker で、origin の引数を持たない。
		send: (message) => worker.postMessage(message),
		onMessage: (listener) => worker.on("message", listener),
		onError: (listener) => worker.on("error", listener),
		onExit: (listener) => worker.on("exit", listener),
		terminate: async () => await worker.terminate(),
	};
}

export function createMineflayerConnector(
	settings: Readonly<{ host: string; port: number; username: string; actionsDir: string }>,
	spawn: () => WorkerLike,
): MinecraftConnector {
	return async (listener) => {
		const connection = new MineflayerConnection(spawn(), listener);
		try {
			await connection.request(
				{ type: "connect", ...settings },
				responseValueSchemas.connect,
				AbortSignal.timeout(CONNECT_TIMEOUT_MS),
			);
		} catch (error: unknown) {
			await connection.terminate();
			throw error;
		}
		return connection;
	};
}

class MineflayerConnection implements MinecraftConnection {
	readonly #pending = new Map<number, Pending>();
	#closing = false;
	#gone = false;
	#nextId = 0;

	constructor(
		private readonly worker: WorkerLike,
		private readonly listener: ConnectionListener,
	) {
		worker.onMessage((message) => {
			this.#receive(message);
		});
		worker.onError((error) => {
			this.#lose(`Minecraft worker failed: ${error.message}`);
		});
		worker.onExit((code) => {
			this.#lose(`Minecraft worker exited with code ${String(code)}`);
		});
	}

	async observe(request: Parameters<MinecraftConnection["observe"]>[0]) {
		return await this.request(
			{ type: "observe", verify: [...request.verify], targetItems: [...request.targetItems] },
			responseValueSchemas.observe,
			AbortSignal.timeout(QUERY_TIMEOUT_MS),
		);
	}

	async execute(
		action: Parameters<MinecraftConnection["execute"]>[0],
		signal: AbortSignal,
	): Promise<ActionOutcome> {
		return await this.request(
			{ type: "execute", action },
			responseValueSchemas.execute,
			signal,
			(id) => {
				// 中断しても返事（interrupted）は待つ。入力を離したことをワーカーが確かめてから返すため。
				// ただしワーカーが固まっていたら、上限を過ぎた時点で失敗にする。
				this.#post({ type: "abort", id });
				setTimeout(() => {
					this.#fail(id, new Error("Minecraft worker did not stop the action"));
				}, ABORT_GRACE_MS).unref();
			},
		);
	}

	async unknownItems(names: readonly string[]): Promise<readonly string[]> {
		return await this.request(
			{ type: "unknownItems", names: [...names] },
			responseValueSchemas.unknownItems,
			AbortSignal.timeout(QUERY_TIMEOUT_MS),
		);
	}

	async customActions() {
		return await this.request(
			{ type: "customActions" },
			responseValueSchemas.customActions,
			AbortSignal.timeout(QUERY_TIMEOUT_MS),
		);
	}

	async close(): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;
		try {
			await this.request(
				{ type: "close" },
				responseValueSchemas.close,
				AbortSignal.timeout(CLOSE_TIMEOUT_MS),
			);
		} finally {
			await this.terminate();
		}
	}

	async terminate(): Promise<void> {
		this.#closing = true;
		await this.worker.terminate();
	}

	request<Schema extends z.ZodType>(
		body: RequestBody,
		schema: Schema,
		signal?: AbortSignal,
		onAbort?: (id: number) => void,
	): Promise<z.infer<Schema>> {
		if (this.#gone) return Promise.reject(new Error("Minecraft connection is closed"));
		const id = this.#nextId;
		this.#nextId += 1;
		const done = Promise.withResolvers<z.infer<Schema>>();
		this.#pending.set(id, {
			resolve: (value) => {
				done.resolve(schema.parse(value));
			},
			reject: (error) => done.reject(error),
		});
		const abort = (): void => {
			if (onAbort !== undefined) {
				onAbort(id);
				return;
			}
			this.#pending.delete(id);
			done.reject(new Error(`Minecraft ${body.type} was aborted`));
		};
		if (signal?.aborted ?? false) {
			this.#pending.delete(id);
			done.reject(new Error(`Minecraft ${body.type} was aborted before it started`));
		} else {
			signal?.addEventListener("abort", abort, { once: true });
			this.#post({ ...body, id });
		}
		return done.promise.finally(() => signal?.removeEventListener("abort", abort));
	}

	#fail(id: number, error: Error): void {
		const pending = this.#pending.get(id);
		if (pending === undefined) return;
		this.#pending.delete(id);
		pending.reject(error);
	}

	#post(request: WorkerRequest): void {
		if (this.#gone) return;
		this.worker.send(request);
	}

	#receive(raw: unknown): void {
		const parsed = workerMessageSchema.safeParse(raw);
		if (!parsed.success) {
			this.#lose(`Minecraft worker sent an invalid message: ${parsed.error.message}`);
			return;
		}
		const message = parsed.data;
		if (message.type === "response") {
			const pending = this.#pending.get(message.id);
			if (pending === undefined) return;
			this.#pending.delete(message.id);
			if (message.ok) {
				try {
					pending.resolve(message.value);
				} catch (error: unknown) {
					pending.reject(error instanceof Error ? error : new Error(String(error)));
				}
			} else {
				pending.reject(new Error(message.error));
			}
			return;
		}
		if (message.type === "reflexed") this.listener.reflexed(message);
		else if (message.type === "died") this.listener.died(message);
		else this.#lose(message.reason);
	}

	#lose(reason: string): void {
		if (this.#gone) return;
		this.#gone = true;
		for (const pending of this.#pending.values()) pending.reject(new Error(reason));
		this.#pending.clear();
		void this.worker.terminate();
		if (!this.#closing) this.listener.disconnected(reason);
	}
}
