import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ConnectionListener } from "../ports/minecraft-connection-port";
import { snapshotWith } from "../testing/world-fixtures";
import { createMineflayerConnector } from "./mineflayer-connection";
import type { WorkerLike } from "./mineflayer-connection";
import type { WorkerRequest } from "./mineflayer-protocol";

const SETTINGS = { host: "127.0.0.1", port: 25_565, username: "Luna" };

class FakeWorker implements WorkerLike {
	readonly posted: WorkerRequest[] = [];
	readonly terminate = vi.fn(async () => 0);
	readonly #messages: Array<(message: unknown) => void> = [];
	readonly #exits: Array<(code: number) => void> = [];
	reply: (request: WorkerRequest) => unknown = () => null;

	onMessage(handler: (message: unknown) => void): void {
		this.#messages.push(handler);
	}

	onError(): void {}

	onExit(handler: (code: number) => void): void {
		this.#exits.push(handler);
	}

	receive(message: unknown): void {
		for (const handler of this.#messages) handler(message);
	}

	exit(code: number): void {
		for (const handler of this.#exits) handler(code);
	}

	send(message: WorkerRequest): void {
		this.posted.push(message);
		if (message.type === "abort") return;
		const value = this.reply(message);
		if (value === NO_REPLY) return;
		queueMicrotask(() => {
			this.receive(
				value instanceof Error
					? { type: "response", id: message.id, ok: false, error: value.message }
					: { type: "response", id: message.id, ok: true, value },
			);
		});
	}
}

const NO_REPLY = Symbol("no reply");

function listener() {
	return {
		reflexed: vi.fn<ConnectionListener["reflexed"]>(),
		died: vi.fn<ConnectionListener["died"]>(),
		disconnected: vi.fn<ConnectionListener["disconnected"]>(),
	};
}

async function connected(reply?: (request: WorkerRequest) => unknown) {
	const worker = new FakeWorker();
	if (reply !== undefined) worker.reply = reply;
	const events = listener();
	const connection = await createMineflayerConnector(SETTINGS, () => worker)(events);
	return { connection, events, worker };
}

describe("createMineflayerConnector", () => {
	it("ワーカーに接続を頼み、観測の返事をスキーマで確かめて返す", async () => {
		const snapshot = snapshotWith({ inventory: { oak_log: 3 } });
		const { connection, worker } = await connected((request) =>
			request.type === "observe" ? snapshot : null,
		);

		await expect(
			connection.observe({ targetItems: ["oak_log"], verify: [{ x: 1, y: 2, z: 3 }] }),
		).resolves.toEqual(snapshot);
		expect(worker.posted.slice(0, 2)).toEqual([
			{ type: "connect", id: 0, ...SETTINGS },
			{ type: "observe", id: 1, targetItems: ["oak_log"], verify: [{ x: 1, y: 2, z: 3 }] },
		]);
	});

	it("接続に失敗したらワーカーを止めて例外にする", async () => {
		const worker = new FakeWorker();
		worker.reply = () => new Error("Could not join the Minecraft server: ECONNREFUSED");

		await expect(createMineflayerConnector(SETTINGS, () => worker)(listener())).rejects.toThrow(
			"ECONNREFUSED",
		);
		expect(worker.terminate).toHaveBeenCalledOnce();
	});

	it("形の合わない返事は例外にする", async () => {
		const { connection } = await connected((request) =>
			request.type === "observe" ? { self: "broken" } : null,
		);

		await expect(connection.observe({ targetItems: [], verify: [] })).rejects.toBeInstanceOf(
			z.ZodError,
		);
	});

	it("行動を中断したら abort を送り、ワーカーの interrupted の返事を待って返す", async () => {
		const { connection, worker } = await connected((request) =>
			request.type === "execute" ? NO_REPLY : null,
		);
		const controller = new AbortController();

		const outcome = connection.execute({ type: "wait" }, controller.signal);
		controller.abort();
		const execute = worker.posted.find((request) => request.type === "execute");
		expect(worker.posted.at(-1)).toEqual({ type: "abort", id: execute?.id });
		worker.receive({
			type: "response",
			id: execute?.id,
			ok: true,
			value: { result: "interrupted", detail: "aborted", chest: null },
		});

		await expect(outcome).resolves.toEqual({
			result: "interrupted",
			detail: "aborted",
			chest: null,
		});
	});

	it("中断してもワーカーが返事をしなければ、上限を過ぎた時点で失敗にする", async () => {
		vi.useFakeTimers();
		try {
			const { connection } = await connected((request) =>
				request.type === "execute" ? NO_REPLY : null,
			);
			const controller = new AbortController();
			const outcome = connection.execute({ type: "wait" }, controller.signal);

			controller.abort();
			const rejected = outcome.catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(5_000);

			expect(await rejected).toEqual(new Error("Minecraft worker did not stop the action"));
		} finally {
			vi.useRealTimers();
		}
	});

	it("形の合わない知らせは切断として扱い、待っている要求を失敗させる", async () => {
		const { connection, events, worker } = await connected((request) =>
			request.type === "observe" ? NO_REPLY : null,
		);
		const pending = connection.observe({ targetItems: [], verify: [] });

		worker.receive({ type: "unknown" });

		await expect(pending).rejects.toThrow("invalid message");
		expect(events.disconnected).toHaveBeenCalledWith(expect.stringContaining("invalid message"));
	});

	it("反射と死亡の知らせをそのまま渡す", async () => {
		const { events, worker } = await connected();

		worker.receive({ type: "reflexed", trigger: "drowning", detail: "swam up" });
		worker.receive({
			type: "died",
			message: "Luna drowned",
			position: { x: 1, y: 2, z: 3 },
			dimension: "overworld",
			lostItems: { bread: 2 },
		});

		expect(events.reflexed).toHaveBeenCalledWith({
			type: "reflexed",
			trigger: "drowning",
			detail: "swam up",
		});
		expect(events.died).toHaveBeenCalledWith(expect.objectContaining({ message: "Luna drowned" }));
	});

	it("サーバーからの切断とワーカーの終了は、待っている要求を失敗させて一度だけ知らせる", async () => {
		const { connection, events, worker } = await connected((request) =>
			request.type === "observe" ? NO_REPLY : null,
		);
		const pending = connection.observe({ targetItems: [], verify: [] });

		worker.receive({ type: "disconnected", reason: "Kicked: idle" });
		worker.exit(1);

		await expect(pending).rejects.toThrow("Kicked: idle");
		expect(events.disconnected).toHaveBeenCalledOnce();
		expect(events.disconnected).toHaveBeenCalledWith("Kicked: idle");
		await expect(connection.observe({ targetItems: [], verify: [] })).rejects.toThrow("closed");
	});

	it("自分で閉じた時は切断として知らせず、ワーカーを止める", async () => {
		const { connection, events, worker } = await connected();

		await connection.close();
		worker.exit(0);

		expect(worker.posted.at(-1)).toMatchObject({ type: "close" });
		expect(worker.terminate).toHaveBeenCalled();
		expect(events.disconnected).not.toHaveBeenCalled();
	});
});
