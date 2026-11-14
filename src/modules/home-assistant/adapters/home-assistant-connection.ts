import { z } from "zod";

import type { LoggerPort } from "../../observability/ports/logger-port";
import type {
	HomeAssistantConnectionPhase,
	HomeAssistantConnectionStatus,
} from "../domain/home-assistant-status";
import type { StateChange } from "../domain/state-change";
import { homeAssistantStateSchema } from "./home-assistant-rest-client";

const RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 30_000, 60_000];
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;

type HomeAssistantSocket = Readonly<{
	send(text: string): void;
	close(): void;
}>;

export type HomeAssistantSocketHandlers = Readonly<{
	onMessage(text: string): void;
	onClose(reason: string): void;
}>;

export type CreateHomeAssistantSocket = (
	url: URL,
	handlers: HomeAssistantSocketHandlers,
) => HomeAssistantSocket;

type Timer = Readonly<{ cancel(): void }>;

type PendingRequest = Readonly<{
	resolve(result: unknown): void;
	reject(error: Error): void;
	timer: Timer;
}>;

const messageSchema = z.discriminatedUnion("type", [
	z.looseObject({ type: z.literal("auth_required") }),
	z.looseObject({ type: z.literal("auth_ok") }),
	z.looseObject({ type: z.literal("auth_invalid"), message: z.string().optional() }),
	z.looseObject({
		type: z.literal("result"),
		id: z.number(),
		success: z.boolean(),
		result: z.unknown().optional(),
		error: z.looseObject({ message: z.string().optional() }).nullish(),
	}),
	z.looseObject({ type: z.literal("pong"), id: z.number() }),
	z.looseObject({ type: z.literal("event"), id: z.number(), event: z.unknown() }),
]);

const stateChangedEventSchema = z.looseObject({
	event_type: z.literal("state_changed"),
	data: z.looseObject({
		entity_id: z.string(),
		old_state: homeAssistantStateSchema.nullable(),
		new_state: homeAssistantStateSchema.nullable(),
	}),
});

export class HomeAssistantConnectionError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "HomeAssistantConnectionError";
	}
}

class SocketSession {
	nextId = 1;
	subscriptionId: number | undefined;
	authenticated = false;
	readonly pending = new Map<number, PendingRequest>();
	pingTimer: Timer | undefined;
	pongTimer: Timer | undefined;

	constructor(readonly socket: HomeAssistantSocket) {}
}

export class HomeAssistantConnection {
	#session: SocketSession | undefined;
	#retryTimer: Timer | undefined;
	#retryIndex = 0;
	#stopped = true;
	#phase: HomeAssistantConnectionPhase = "connecting";
	#phaseSince: Date;
	#nextRetryAt: Date | undefined;
	#lastError: { message: string; at: Date } | undefined;

	constructor(
		private readonly dependencies: Readonly<{
			url: URL;
			token: string;
			createSocket: CreateHomeAssistantSocket;
			logger: LoggerPort;
			now: () => Date;
			setTimer(delayMs: number, callback: () => void): Timer;
			onStateChanged(change: StateChange): void;
		}>,
	) {
		this.#phaseSince = dependencies.now();
	}

	start(): void {
		this.#stopped = false;
		this.#connect();
	}

	stop(): void {
		this.#stopped = true;
		this.#retryTimer?.cancel();
		this.#retryTimer = undefined;
		const session = this.#session;
		this.#session = undefined;
		if (session !== undefined) this.#dispose(session, "connection stopped");
	}

	status(): HomeAssistantConnectionStatus {
		return {
			phase: this.#phase,
			phaseSince: this.#phaseSince.toISOString(),
			nextRetryAt: this.#nextRetryAt?.toISOString() ?? null,
			lastError:
				this.#lastError === undefined
					? null
					: { message: this.#lastError.message, at: this.#lastError.at.toISOString() },
		};
	}

	async request(message: Readonly<Record<string, unknown>>): Promise<unknown> {
		const session = this.#session;
		if (session === undefined || !session.authenticated) {
			throw new HomeAssistantConnectionError("Home Assistant WebSocket is not connected.");
		}
		const id = session.nextId++;
		return await new Promise<unknown>((resolve, reject) => {
			const timer = this.dependencies.setTimer(REQUEST_TIMEOUT_MS, () => {
				session.pending.delete(id);
				reject(
					new HomeAssistantConnectionError(
						`Home Assistant request timed out: ${String(message["type"])}.`,
					),
				);
			});
			session.pending.set(id, { resolve, reject, timer });
			session.socket.send(JSON.stringify({ ...message, id }));
		});
	}

	#connect(): void {
		this.#nextRetryAt = undefined;
		this.#enter("connecting");
		const url = new URL("/api/websocket", this.dependencies.url);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		let session: SocketSession | undefined;
		try {
			const socket = this.dependencies.createSocket(url, {
				onMessage: (text) => {
					if (session !== undefined && this.#session === session)
						this.#handleMessage(session, text);
				},
				onClose: (reason) => {
					if (session !== undefined && this.#session === session)
						this.#handleClose(session, reason);
				},
			});
			session = new SocketSession(socket);
			this.#session = session;
		} catch (error: unknown) {
			this.#recordError("home_assistant.ws.connect_failed", error);
			this.#scheduleRetry();
		}
	}

	#handleMessage(session: SocketSession, text: string): void {
		let parsed: z.infer<typeof messageSchema>;
		try {
			const result = messageSchema.safeParse(JSON.parse(text));
			if (!result.success) return;
			parsed = result.data;
		} catch (error: unknown) {
			this.dependencies.logger.warn("home_assistant.ws.message_invalid", { error });
			return;
		}
		switch (parsed.type) {
			case "auth_required":
				session.socket.send(
					JSON.stringify({ type: "auth", access_token: this.dependencies.token }),
				);
				return;
			case "auth_ok":
				this.#handleAuthenticated(session);
				return;
			case "auth_invalid":
				this.#recordError(
					"home_assistant.ws.auth_failed",
					new HomeAssistantConnectionError(
						`Home Assistant rejected the token: ${parsed.message ?? "auth_invalid"}.`,
					),
				);
				session.socket.close();
				return;
			case "result":
				this.#handleResult(session, parsed);
				return;
			case "pong":
				session.pongTimer?.cancel();
				session.pongTimer = undefined;
				return;
			case "event":
				if (parsed.id === session.subscriptionId) this.#handleEvent(parsed.event);
				return;
			default:
				throw new Error(
					`Unhandled Home Assistant message: ${JSON.stringify(parsed satisfies never)}`,
				);
		}
	}

	#handleAuthenticated(session: SocketSession): void {
		session.authenticated = true;
		this.#retryIndex = 0;
		this.#enter("connected");
		this.dependencies.logger.info("home_assistant.ws.connected");
		const subscriptionId = session.nextId++;
		session.subscriptionId = subscriptionId;
		session.socket.send(
			JSON.stringify({ id: subscriptionId, type: "subscribe_events", event_type: "state_changed" }),
		);
		this.#schedulePing(session);
	}

	#handleResult(
		session: SocketSession,
		message: Extract<z.infer<typeof messageSchema>, { type: "result" }>,
	): void {
		if (message.id === session.subscriptionId) {
			if (!message.success) {
				this.#recordError(
					"home_assistant.ws.subscribe_failed",
					new HomeAssistantConnectionError(
						`Home Assistant rejected the subscription: ${message.error?.message ?? "unknown error"}.`,
					),
				);
				session.socket.close();
			}
			return;
		}
		const pending = session.pending.get(message.id);
		if (pending === undefined) return;
		session.pending.delete(message.id);
		pending.timer.cancel();
		if (message.success) pending.resolve(message.result);
		else
			pending.reject(
				new HomeAssistantConnectionError(
					`Home Assistant request failed: ${message.error?.message ?? "unknown error"}.`,
				),
			);
	}

	#handleEvent(event: unknown): void {
		const parsed = stateChangedEventSchema.safeParse(event);
		if (!parsed.success) {
			this.dependencies.logger.warn("home_assistant.ws.event_invalid", {
				error: z.prettifyError(parsed.error),
			});
			return;
		}
		this.dependencies.onStateChanged({
			entityId: parsed.data.data.entity_id,
			oldState: parsed.data.data.old_state,
			newState: parsed.data.data.new_state,
		});
	}

	#schedulePing(session: SocketSession): void {
		session.pingTimer = this.dependencies.setTimer(PING_INTERVAL_MS, () => {
			if (this.#session !== session) return;
			session.socket.send(JSON.stringify({ id: session.nextId++, type: "ping" }));
			session.pongTimer = this.dependencies.setTimer(PONG_TIMEOUT_MS, () => {
				if (this.#session !== session) return;
				this.#recordError(
					"home_assistant.ws.pong_timeout",
					new HomeAssistantConnectionError("Home Assistant did not answer a ping."),
				);
				session.socket.close();
				this.#handleClose(session, "pong timeout");
			});
			this.#schedulePing(session);
		});
	}

	#handleClose(session: SocketSession, reason: string): void {
		this.#session = undefined;
		this.#dispose(session, reason);
		if (this.#stopped) return;
		this.dependencies.logger.warn("home_assistant.ws.disconnected", { reason });
		this.#scheduleRetry();
	}

	#dispose(session: SocketSession, reason: string): void {
		session.pingTimer?.cancel();
		session.pongTimer?.cancel();
		for (const pending of session.pending.values()) {
			pending.timer.cancel();
			pending.reject(
				new HomeAssistantConnectionError(`Home Assistant WebSocket closed: ${reason}.`),
			);
		}
		session.pending.clear();
		try {
			session.socket.close();
		} catch {
			// 閉じる途中の失敗は、どのみち捨てる接続なので無視する。
		}
	}

	#scheduleRetry(): void {
		if (this.#stopped) return;
		const delayMs = RETRY_DELAYS_MS[Math.min(this.#retryIndex, RETRY_DELAYS_MS.length - 1)] ?? 0;
		this.#retryIndex += 1;
		this.#enter("waiting_retry");
		this.#nextRetryAt = new Date(this.dependencies.now().getTime() + delayMs);
		this.#retryTimer = this.dependencies.setTimer(delayMs, () => {
			this.#retryTimer = undefined;
			if (!this.#stopped) this.#connect();
		});
	}

	#recordError(event: string, error: unknown): void {
		this.#lastError = {
			message: error instanceof Error ? error.message : String(error),
			at: this.dependencies.now(),
		};
		this.dependencies.logger.error(event, { error });
	}

	#enter(phase: HomeAssistantConnectionPhase): void {
		this.#phase = phase;
		this.#phaseSince = this.dependencies.now();
	}
}

export const createNodeHomeAssistantSocket: CreateHomeAssistantSocket = (url, handlers) => {
	const socket = new WebSocket(url);
	socket.addEventListener("message", (event) => {
		if (typeof event.data === "string") handlers.onMessage(event.data);
	});
	socket.addEventListener("close", (event) => {
		handlers.onClose(`code ${event.code}${event.reason === "" ? "" : `: ${event.reason}`}`);
	});
	return {
		send: (text) => socket.send(text),
		close: () => socket.close(),
	};
};
