import { describe, expect, it } from "vitest";

import { createRecordingLogger } from "../../observability/testing/recording-logger";
import type { StateChange } from "../domain/state-change";
import { HomeAssistantConnection, HomeAssistantConnectionError } from "./home-assistant-connection";
import type { HomeAssistantSocketHandlers } from "./home-assistant-connection";

describe("HomeAssistantConnection", () => {
	it("URLからws(s)の/api/websocketを導いて接続し、auth_requiredにトークンを送る", () => {
		const harness = createHarness("https://ha.example.com:8443/");

		harness.connection.start();
		harness.socket().receive({ type: "auth_required" });

		expect(harness.socket().url).toBe("wss://ha.example.com:8443/api/websocket");
		expect(harness.socket().sent).toEqual([{ type: "auth", access_token: "secret" }]);
		expect(harness.connection.status()).toMatchObject({ phase: "connecting" });
	});

	it("auth_okでstate_changedを購読して接続済みになる", () => {
		const harness = createHarness();

		harness.connection.start();
		harness.authenticate();

		expect(harness.socket().sent.at(-1)).toEqual({
			id: 1,
			type: "subscribe_events",
			event_type: "state_changed",
		});
		expect(harness.connection.status()).toEqual({
			phase: "connected",
			phaseSince: harness.now().toISOString(),
			nextRetryAt: null,
			lastError: null,
		});
		expect(harness.logger.entries).toContainEqual({
			level: "info",
			event: "home_assistant.ws.connected",
			context: {},
		});
	});

	it("購読のstate_changedを状態変化として渡し、別の購読IDのイベントは無視する", () => {
		const harness = createHarness();
		harness.connection.start();
		harness.authenticate();

		harness.socket().receive({ id: 99, type: "event", event: stateChangedEvent() });
		harness.socket().receive({ id: 1, type: "event", event: stateChangedEvent() });

		expect(harness.changes).toEqual([
			{
				entityId: "binary_sensor.front_door",
				oldState: null,
				newState: {
					entityId: "binary_sensor.front_door",
					state: "on",
					attributes: {},
					lastChanged: "2026-11-14T00:00:00.000Z",
					lastUpdated: "2026-11-14T00:00:00.000Z",
				},
			},
		]);
	});

	it("形の合わないイベントはwarnログを残して捨てる", () => {
		const harness = createHarness();
		harness.connection.start();
		harness.authenticate();

		harness.socket().receive({ id: 1, type: "event", event: { event_type: "state_changed" } });

		expect(harness.changes).toEqual([]);
		expect(harness.logger.entries.map((entry) => entry.event)).toContain(
			"home_assistant.ws.event_invalid",
		);
	});

	it("auth_invalidで接続を閉じ、5秒・10秒・30秒・60秒・60秒と待って再接続する", () => {
		const harness = createHarness();
		harness.connection.start();
		const delays: number[] = [];

		for (let attempt = 0; attempt < 5; attempt += 1) {
			harness.socket().receive({ type: "auth_invalid", message: "Invalid password" });
			expect(harness.socket().closed).toBe(true);
			harness.socket().closeFromServer();
			const timer = harness.pendingTimers().at(-1);
			if (timer === undefined) throw new Error("retry timer is missing");
			delays.push(timer.delayMs);
			harness.fire(timer);
		}

		expect(delays).toEqual([5_000, 10_000, 30_000, 60_000, 60_000]);
		expect(harness.sockets).toHaveLength(6);
		expect(harness.connection.status().lastError).toEqual({
			message: "Home Assistant rejected the token: Invalid password.",
			at: new Date(harness.now().getTime() - 60_000).toISOString(),
		});
		expect(harness.logger.entries.map((entry) => entry.event)).toContain(
			"home_assistant.ws.auth_failed",
		);
	});

	it("再接続待ちの間は再接続の予定時刻を示し、認証に成功したら待ち時間を最初に戻す", () => {
		const harness = createHarness();
		harness.connection.start();
		harness.socket().closeFromServer("code 1006");
		expect(harness.connection.status()).toMatchObject({
			phase: "waiting_retry",
			nextRetryAt: new Date(harness.now().getTime() + 5_000).toISOString(),
		});
		harness.fire(lastTimer(harness));
		harness.socket().closeFromServer();
		expect(lastTimer(harness).delayMs).toBe(10_000);
		harness.fire(lastTimer(harness));

		harness.authenticate();
		harness.socket().closeFromServer();

		expect(lastTimer(harness).delayMs).toBe(5_000);
		expect(harness.logger.entries).toContainEqual({
			level: "warn",
			event: "home_assistant.ws.disconnected",
			context: {},
			details: { reason: "code 1006" },
		});
	});

	it("30秒ごとにpingを送り、10秒以内にpongがなければ切断して再接続を予約する", () => {
		const harness = createHarness();
		harness.connection.start();
		harness.authenticate();
		const first = harness.socket();

		harness.fire(timerWithDelay(harness, 30_000));
		expect(first.sent.at(-1)).toEqual({ id: 2, type: "ping" });
		harness.fire(timerWithDelay(harness, 10_000));

		expect(first.closed).toBe(true);
		expect(harness.connection.status().phase).toBe("waiting_retry");
		expect(lastTimer(harness).delayMs).toBe(5_000);
		expect(harness.connection.status().lastError?.message).toBe(
			"Home Assistant did not answer a ping.",
		);
	});

	it("pongが届けば切断しない", () => {
		const harness = createHarness();
		harness.connection.start();
		harness.authenticate();

		harness.fire(timerWithDelay(harness, 30_000));
		const pongTimer = timerWithDelay(harness, 10_000);
		harness.socket().receive({ id: 2, type: "pong" });

		expect(pongTimer.cancelled).toBe(true);
		expect(harness.socket().closed).toBe(false);
		expect(harness.connection.status().phase).toBe("connected");
	});

	it("requestはIDを付けて送り、同じIDの結果で解決する", async () => {
		const harness = createHarness();
		harness.connection.start();
		harness.authenticate();

		const pending = harness.connection.request({ type: "config/area_registry/list" });
		harness.socket().receive({ id: 2, type: "result", success: true, result: [{ area_id: "a" }] });

		await expect(pending).resolves.toEqual([{ area_id: "a" }]);
		expect(harness.socket().sent.at(-1)).toEqual({ type: "config/area_registry/list", id: 2 });
	});

	it("requestの失敗結果はHAのメッセージを含むエラーにする", async () => {
		const harness = createHarness();
		harness.connection.start();
		harness.authenticate();

		const pending = harness.connection.request({ type: "config/area_registry/list" });
		harness
			.socket()
			.receive({ id: 2, type: "result", success: false, error: { message: "Unauthorized" } });

		await expect(pending).rejects.toThrow(
			new HomeAssistantConnectionError("Home Assistant request failed: Unauthorized."),
		);
	});

	it("requestは20秒で応答がなければタイムアウトする", async () => {
		const harness = createHarness();
		harness.connection.start();
		harness.authenticate();

		const pending = harness.connection.request({ type: "config/area_registry/list" });
		harness.fire(timerWithDelay(harness, 20_000));

		await expect(pending).rejects.toThrow(
			"Home Assistant request timed out: config/area_registry/list.",
		);
	});

	it("認証前のrequestは未接続として失敗する", async () => {
		const harness = createHarness();
		harness.connection.start();

		await expect(harness.connection.request({ type: "ping" })).rejects.toThrow(
			new HomeAssistantConnectionError("Home Assistant WebSocket is not connected."),
		);
	});

	it("切断すると保留中のrequestを失敗させる", async () => {
		const harness = createHarness();
		harness.connection.start();
		harness.authenticate();

		const pending = harness.connection.request({ type: "config/area_registry/list" });
		harness.socket().closeFromServer("code 1001");

		await expect(pending).rejects.toThrow("Home Assistant WebSocket closed: code 1001.");
	});

	it("stopの後は接続を閉じて再接続しない", () => {
		const harness = createHarness();
		harness.connection.start();
		harness.authenticate();

		harness.connection.stop();
		harness.socket().closeFromServer();

		expect(harness.socket().closed).toBe(true);
		expect(harness.pendingTimers()).toEqual([]);
		expect(harness.sockets).toHaveLength(1);
	});

	it("再接続待ちの間にstopすると予約した再接続を取り消す", () => {
		const harness = createHarness();
		harness.connection.start();
		harness.socket().closeFromServer();
		const retry = lastTimer(harness);

		harness.connection.stop();

		expect(retry.cancelled).toBe(true);
	});

	it("ソケットの作成が例外を投げたらエラーを記録して再試行を予約する", () => {
		const harness = createHarness();
		harness.failNextSocket(new Error("bad url"));

		harness.connection.start();

		expect(harness.connection.status()).toMatchObject({
			phase: "waiting_retry",
			lastError: { message: "bad url" },
		});
		expect(lastTimer(harness).delayMs).toBe(5_000);
		harness.fire(lastTimer(harness));
		expect(harness.sockets).toHaveLength(1);
	});

	it("JSONでないメッセージはwarnログを残して無視する", () => {
		const harness = createHarness();
		harness.connection.start();

		harness.socket().receiveText("not json");

		expect(harness.logger.entries.map((entry) => entry.event)).toEqual([
			"home_assistant.ws.message_invalid",
		]);
		expect(harness.connection.status().phase).toBe("connecting");
	});

	it("購読が拒否されたらエラーを記録して接続を閉じる", () => {
		const harness = createHarness();
		harness.connection.start();
		harness.authenticate();

		harness
			.socket()
			.receive({ id: 1, type: "result", success: false, error: { message: "denied" } });

		expect(harness.socket().closed).toBe(true);
		expect(harness.connection.status().lastError?.message).toBe(
			"Home Assistant rejected the subscription: denied.",
		);
	});
});

type FakeTimer = { delayMs: number; callback: () => void; cancelled: boolean; fired: boolean };

class FakeSocket {
	readonly sent: unknown[] = [];
	closed = false;

	constructor(
		readonly url: string,
		private readonly handlers: HomeAssistantSocketHandlers,
	) {}

	send(text: string): void {
		this.sent.push(JSON.parse(text));
	}

	close(): void {
		this.closed = true;
	}

	receive(message: unknown): void {
		this.handlers.onMessage(JSON.stringify(message));
	}

	receiveText(text: string): void {
		this.handlers.onMessage(text);
	}

	closeFromServer(reason = "code 1000"): void {
		this.closed = true;
		this.handlers.onClose(reason);
	}
}

function createHarness(url = "http://192.168.0.104:8123") {
	let now = new Date("2026-11-14T00:00:00.000Z");
	const timers: FakeTimer[] = [];
	const sockets: FakeSocket[] = [];
	const changes: StateChange[] = [];
	const logger = createRecordingLogger();
	let nextSocketFailure: Error | undefined;
	const connection = new HomeAssistantConnection({
		url: new URL(url),
		token: "secret",
		createSocket: (socketUrl, handlers) => {
			if (nextSocketFailure !== undefined) {
				const failure = nextSocketFailure;
				nextSocketFailure = undefined;
				throw failure;
			}
			const socket = new FakeSocket(socketUrl.toString(), handlers);
			sockets.push(socket);
			return socket;
		},
		logger,
		now: () => now,
		setTimer: (delayMs, callback) => {
			const timer: FakeTimer = { delayMs, callback, cancelled: false, fired: false };
			timers.push(timer);
			return {
				cancel: () => {
					timer.cancelled = true;
				},
			};
		},
		onStateChanged: (change) => changes.push(change),
	});
	const socket = (): FakeSocket => {
		const latest = sockets.at(-1);
		if (latest === undefined) throw new Error("socket is missing");
		return latest;
	};
	return {
		changes,
		connection,
		logger,
		now: () => now,
		sockets,
		socket,
		authenticate: (): void => {
			socket().receive({ type: "auth_required" });
			socket().receive({ type: "auth_ok" });
		},
		failNextSocket: (error: Error): void => {
			nextSocketFailure = error;
		},
		pendingTimers: (): FakeTimer[] => timers.filter((timer) => !timer.cancelled && !timer.fired),
		fire: (timer: FakeTimer): void => {
			now = new Date(now.getTime() + timer.delayMs);
			timer.fired = true;
			timer.callback();
		},
	};
}

function lastTimer(harness: ReturnType<typeof createHarness>): FakeTimer {
	const timer = harness.pendingTimers().at(-1);
	if (timer === undefined) throw new Error("timer is missing");
	return timer;
}

function timerWithDelay(harness: ReturnType<typeof createHarness>, delayMs: number): FakeTimer {
	const timer = harness.pendingTimers().find((candidate) => candidate.delayMs === delayMs);
	if (timer === undefined) throw new Error(`timer with ${String(delayMs)}ms is missing`);
	return timer;
}

function stateChangedEvent() {
	return {
		event_type: "state_changed",
		data: {
			entity_id: "binary_sensor.front_door",
			old_state: null,
			new_state: {
				entity_id: "binary_sensor.front_door",
				state: "on",
				attributes: {},
				last_changed: "2026-11-14T00:00:00.000Z",
				last_updated: "2026-11-14T00:00:00.000Z",
			},
		},
		time_fired: "2026-11-14T00:00:00.000Z",
	};
}
