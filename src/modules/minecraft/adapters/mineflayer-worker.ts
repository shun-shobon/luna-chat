import { parentPort } from "node:worker_threads";

import { MineflayerPlayer } from "./mineflayer-player";
import { workerRequestSchema } from "./mineflayer-protocol";
import type { WorkerMessage, WorkerRequest } from "./mineflayer-protocol";

// Mineflayer の経路探索はイベントループを止めるため、メインスレッドから外したこのワーカーで動かす。
const port = parentPort;
if (port == null) throw new Error("mineflayer-worker must run in a worker thread");

let player: MineflayerPlayer | undefined;
const running = new Map<number, AbortController>();

const send = (message: WorkerMessage): void => {
	port.postMessage(message);
};

port.on("message", (raw: unknown) => {
	const request = workerRequestSchema.parse(raw);
	if (request.type === "abort") {
		running.get(request.id)?.abort();
		return;
	}
	void handle(request).then(
		(value) => send({ type: "response", id: request.id, ok: true, value }),
		(error: unknown) =>
			send({
				type: "response",
				id: request.id,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			}),
	);
});

async function handle(request: Exclude<WorkerRequest, { type: "abort" }>): Promise<unknown> {
	switch (request.type) {
		case "connect":
			if (player !== undefined) throw new Error("Already connected");
			player = await MineflayerPlayer.connect(request, {
				reflexed: (event) => send({ type: "reflexed", ...event }),
				died: (event) => send({ type: "died", ...event, lostItems: { ...event.lostItems } }),
				disconnected: (reason) => send({ type: "disconnected", reason }),
			});
			return null;
		case "observe":
			return requirePlayer().observe(request);
		case "execute": {
			const controller = new AbortController();
			running.set(request.id, controller);
			try {
				return await requirePlayer().execute(request.action, controller.signal);
			} finally {
				running.delete(request.id);
			}
		}
		case "unknownItems":
			return requirePlayer().unknownItems(request.names);
		case "close":
			await player?.close();
			player = undefined;
			return null;
		default: {
			const unknownRequest: never = request;
			throw new Error(`Unknown worker request: ${JSON.stringify(unknownRequest)}`);
		}
	}
}

function requirePlayer(): MineflayerPlayer {
	if (player === undefined) throw new Error("Not connected");
	return player;
}
