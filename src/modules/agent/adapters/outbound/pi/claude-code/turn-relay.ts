import { randomBytes } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";

import { z } from "zod";

import { parseAnthropicStreamEvent } from "./native-types";
import type { AnthropicStreamEvent, NativeMessage } from "./native-types";

const toolInputSchema = z.record(z.string(), z.unknown());
const errorBodySchema = z.object({ error: z.object({ message: z.string() }) });

export class AnthropicCapture {
	message?: NativeMessage;
	complete = false;
	// HTTP 200 のストリームの中で届いたエラー。
	error?: string;
	private pending = "";
	private readonly decoder = new TextDecoder();
	private readonly argumentsByIndex = new Map<number, string>();

	constructor(private readonly onEvent?: (event: AnthropicStreamEvent) => void) {}

	feed(chunk: Uint8Array): void {
		this.pending += this.decoder.decode(chunk, { stream: true });
		this.consumeFrames();
	}

	finish(): void {
		this.pending += this.decoder.decode();
		this.consumeFrames();
	}

	private consumeFrames(): void {
		while (true) {
			const match = /\r?\n\r?\n/u.exec(this.pending);
			if (!match) return;
			const frame = this.pending.slice(0, match.index);
			this.pending = this.pending.slice(match.index + match[0].length);
			const data = frame
				.split(/\r?\n/u)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (data === "" || data === "[DONE]") continue;
			const event = parseAnthropicStreamEvent(JSON.parse(data));
			if (event === undefined) continue;
			this.apply(event);
			this.onEvent?.(event);
		}
	}

	private apply(event: AnthropicStreamEvent): void {
		switch (event.type) {
			case "message_start": {
				this.message = structuredClone(event.message);
				break;
			}
			case "content_block_start": {
				if (this.message) this.message.content[event.index] = structuredClone(event.content_block);
				break;
			}
			case "content_block_delta": {
				const block = this.message?.content[event.index];
				if (!block) break;
				const delta = event.delta;
				if (delta.type === "text_delta" && block.type === "text") block.text += delta.text;
				else if (delta.type === "thinking_delta" && block.type === "thinking") {
					block.thinking += delta.thinking;
				} else if (delta.type === "signature_delta" && block.type === "thinking") {
					block.signature = (block.signature ?? "") + delta.signature;
				} else if (delta.type === "input_json_delta" && block.type === "tool_use") {
					this.argumentsByIndex.set(
						event.index,
						(this.argumentsByIndex.get(event.index) ?? "") + delta.partial_json,
					);
				}
				break;
			}
			case "content_block_stop": {
				const block = this.message?.content[event.index];
				const raw = this.argumentsByIndex.get(event.index);
				if (block?.type === "tool_use" && raw !== undefined) {
					block.input = raw.trim() === "" ? {} : toolInputSchema.parse(JSON.parse(raw));
					this.argumentsByIndex.delete(event.index);
				}
				break;
			}
			case "message_delta": {
				if (this.message) {
					Object.assign(this.message, event.delta);
					if (event.usage) this.message.usage = mergeUsage(this.message.usage, event.usage);
				}
				break;
			}
			case "message_stop": {
				this.complete =
					typeof this.message?.stop_reason === "string" &&
					this.message.stop_reason !== "" &&
					this.argumentsByIndex.size === 0;
				break;
			}
			case "error": {
				const parts = [event.error?.type, event.error?.message].filter(
					(part): part is string => typeof part === "string" && part !== "",
				);
				this.error = parts.length > 0 ? parts.join(": ") : "unknown stream error";
				break;
			}
		}
	}
}

// message_delta の usage は差分で、null の項目もある。値のある項目だけを重ねる。
function mergeUsage(
	current: NativeMessage["usage"],
	delta: Record<string, unknown>,
): NativeMessage["usage"] {
	const defined = Object.fromEntries(Object.entries(delta).filter(([, value]) => value != null));
	const input = defined["input_tokens"] ?? current?.input_tokens;
	const output = defined["output_tokens"] ?? current?.output_tokens;
	if (typeof input !== "number" || typeof output !== "number") return current;
	return { ...current, ...defined, input_tokens: input, output_tokens: output };
}

type Destroyable = {
	destroy(error?: Error): void;
};

const STRIPPED_REQUEST_HEADERS = new Set([
	"host",
	"connection",
	"content-length",
	"transfer-encoding",
	"proxy-authorization",
	"proxy-connection",
	"accept-encoding",
]);

const STRIPPED_RESPONSE_HEADERS = new Set(["connection", "transfer-encoding", "server", "date"]);

// 接続エラーは理由を code に、全アドレスへの接続失敗は message の無い AggregateError に入れるため、message だけでは足りない。
export function describeFailure(error: unknown): string {
	if (!(error instanceof Error)) return "UnknownError";
	let text = error.message === "" ? error.name : `${error.name}: ${error.message}`;
	const code = "code" in error ? error.code : undefined;
	if (typeof code === "string" && !text.includes(code)) text += ` (${code})`;
	if (error instanceof AggregateError && error.errors.length > 0) {
		text += ` [${error.errors.map(describeFailure).join("; ")}]`;
	}
	return text;
}

export class TurnRelay {
	capture: AnthropicCapture;
	used = false;
	denied = 0;
	status?: number;
	requestId?: string;
	failure?: string;
	// Anthropic が状態を返す前に上流への要求が失敗した。
	upstreamFailed = false;
	errorBody = Buffer.alloc(0);
	originalRequestBody?: Buffer;
	requestBody?: Buffer;

	private readonly upstream: URL;
	private readonly prefix = `/turn/${randomBytes(32).toString("base64url")}`;
	private readonly server: http.Server;
	private readonly sockets = new Set<Destroyable>();
	private readonly active = new Set<Promise<void>>();
	private cancelled = false;
	private closed = false;
	private transformRequest: ((body: Buffer) => Buffer) | undefined;
	private requestBetas: string[] = [];

	constructor(
		upstream = "https://api.anthropic.com",
		private readonly timeoutMs = 180_000,
		onEvent?: (event: AnthropicStreamEvent) => void,
		transformRequest?: (body: Buffer) => Buffer,
		requestBetas: string[] = [],
	) {
		this.upstream = new URL(upstream);
		const loopback = ["127.0.0.1", "::1", "localhost"].includes(this.upstream.hostname);
		if (
			(this.upstream.protocol !== "https:" && !(this.upstream.protocol === "http:" && loopback)) ||
			this.upstream.username !== "" ||
			this.upstream.password !== "" ||
			this.upstream.search !== "" ||
			this.upstream.hash !== ""
		) {
			throw new Error("Claude Code upstream must be HTTPS or a loopback HTTP fixture");
		}
		this.capture = new AnthropicCapture(onEvent);
		this.transformRequest = transformRequest;
		this.requestBetas = requestBetas;
		this.server = http.createServer((request, response) => {
			const operation = this.handle(request, response).finally(() => this.active.delete(operation));
			this.active.add(operation);
		});
	}

	beginTurn(
		onEvent?: (event: AnthropicStreamEvent) => void,
		transformRequest?: (body: Buffer) => Buffer,
		requestBetas: string[] = [],
	): void {
		if (this.closed) throw new Error("Claude Code turn relay is closed");
		if (this.active.size > 0) throw new Error("Claude Code turn relay still has an active request");
		this.capture = new AnthropicCapture(onEvent);
		this.used = false;
		this.denied = 0;
		this.status = undefined;
		this.requestId = undefined;
		this.failure = undefined;
		this.upstreamFailed = false;
		this.errorBody = Buffer.alloc(0);
		this.originalRequestBody = undefined;
		this.requestBody = undefined;
		this.transformRequest = transformRequest;
		this.requestBetas = requestBetas;
		this.cancelled = false;
	}

	// ワーカーと同じ寿命の HTTP サーバーは閉じず、今のターンだけを解除する。
	finishTurn(): void {
		if (this.cancelled) return;
		this.cancelled = true;
		for (const socket of this.sockets) socket.destroy(new Error("Claude Code request aborted"));
		this.sockets.clear();
		this.server.closeAllConnections();
	}

	async start(): Promise<string> {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				reject(error);
			};
			this.server.once("error", onError);
			this.server.listen(0, "127.0.0.1", () => {
				this.server.off("error", onError);
				resolve();
			});
		});
		const address = this.server.address();
		if (address == null || typeof address === "string") {
			throw new Error("Claude Code turn relay did not get a TCP address");
		}
		return `http://127.0.0.1:${address.port}${this.prefix}`;
	}

	errorText(): string {
		if (this.capture.error !== undefined) return this.capture.error;
		const text = this.errorBody.toString("utf8");
		try {
			const payload = errorBodySchema.safeParse(JSON.parse(text));
			return payload.success ? payload.data.error.message : text;
		} catch {
			return text;
		}
	}

	abort(): void {
		this.finishTurn();
	}

	async settled(): Promise<void> {
		await Promise.allSettled(this.active);
	}

	async close(): Promise<void> {
		this.closed = true;
		this.abort();
		await new Promise<void>((resolve) => {
			if (!this.server.listening) {
				resolve();
				return;
			}
			this.server.close(() => {
				resolve();
			});
		});
		await this.settled();
	}

	// await の間に finishTurn で変わるため、メソッド越しに読んで TypeScript の絞り込みを効かせない。
	private isCancelled(): boolean {
		return this.cancelled;
	}

	private async handle(
		request: http.IncomingMessage,
		response: http.ServerResponse,
	): Promise<void> {
		const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
		if (
			request.method !== "POST" ||
			requestUrl.pathname !== `${this.prefix}/v1/messages` ||
			request.headers.origin !== undefined
		) {
			response.writeHead(404).end();
			return;
		}

		// Claude Code は inert な MCP の呼び出しの後や再試行で、もう一度生成を頼んでくる。1ターン1要求に限る。
		if (this.cancelled || this.used) {
			this.denied += 1;
			const body = Buffer.from(
				JSON.stringify({
					type: "error",
					error: { type: "invalid_request_error", message: "PI_CLAUDE_CODE_TURN_RELAY_CONSUMED" },
				}),
			);
			response
				.writeHead(400, { "content-type": "application/json", "content-length": body.length })
				.end(body);
			return;
		}
		this.used = true;
		this.sockets.add(request);
		this.sockets.add(response);

		let upstreamRequest: http.ClientRequest | undefined;
		try {
			let body = await readBody(request);
			this.originalRequestBody = Buffer.from(body);
			if (this.transformRequest) body = this.transformRequest(body);
			this.requestBody = Buffer.from(body);
			if (this.isCancelled()) return;

			const headers: http.OutgoingHttpHeaders = {};
			for (const [name, value] of Object.entries(request.headers)) {
				if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase()) && value !== undefined) {
					headers[name] = value;
				}
			}
			headers["accept-encoding"] = "identity";
			headers["content-length"] = body.length;
			if (this.requestBetas.length > 0) {
				const beta = request.headers["anthropic-beta"];
				const existing = Array.isArray(beta) ? beta.join(",") : (beta ?? "");
				headers["anthropic-beta"] = [
					...new Set([
						...existing
							.split(",")
							.map((value) => value.trim())
							.filter((value) => value !== ""),
						...this.requestBetas,
					]),
				].join(",");
			}

			const pathPrefix = this.upstream.pathname.replace(/\/$/u, "");
			const transport = this.upstream.protocol === "https:" ? https : http;
			const outgoing = transport.request({
				protocol: this.upstream.protocol,
				hostname: this.upstream.hostname,
				port: this.upstream.port === "" ? undefined : this.upstream.port,
				method: "POST",
				path: `${pathPrefix}/v1/messages${requestUrl.search}`,
				headers,
				timeout: this.timeoutMs,
			});
			upstreamRequest = outgoing;
			this.sockets.add(outgoing);

			const upstreamResponse = await new Promise<http.IncomingMessage>((resolve, reject) => {
				outgoing.once("response", resolve);
				outgoing.once("error", reject);
				outgoing.end(body);
			});
			this.sockets.add(upstreamResponse);
			this.status = upstreamResponse.statusCode;
			const requestId =
				upstreamResponse.headers["request-id"] ?? upstreamResponse.headers["x-request-id"];
			this.requestId = typeof requestId === "string" && requestId !== "" ? requestId : undefined;

			const responseHeaders: http.OutgoingHttpHeaders = {};
			for (const [name, value] of Object.entries(upstreamResponse.headers)) {
				if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase()) && value !== undefined) {
					responseHeaders[name] = value;
				}
			}
			responseHeaders["connection"] = "close";
			response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);

			for await (const rawChunk of upstreamResponse) {
				const chunk = toBuffer(rawChunk);
				if (this.status === 200) this.capture.feed(chunk);
				else if (this.errorBody.length < 65_536) {
					this.errorBody = Buffer.concat([this.errorBody, chunk]).subarray(0, 65_536);
				}
				if (!response.write(chunk)) await waitForDrain(response);
			}
			if (this.status === 200) this.capture.finish();
			response.end();
		} catch (error) {
			this.failure = describeFailure(error);
			this.upstreamFailed =
				upstreamRequest !== undefined && this.status === undefined && !this.isCancelled();
			if (response.headersSent) response.destroy();
			else response.writeHead(this.isCancelled() ? 499 : 502).end();
		} finally {
			if (upstreamRequest) this.sockets.delete(upstreamRequest);
			this.sockets.delete(request);
			this.sockets.delete(response);
			upstreamRequest?.destroy();
		}
	}
}

function toBuffer(chunk: unknown): Buffer {
	if (Buffer.isBuffer(chunk)) return chunk;
	if (typeof chunk === "string") return Buffer.from(chunk);
	if (chunk instanceof Uint8Array) return Buffer.from(chunk);
	throw new Error("Claude Code turn relay received a non-binary chunk");
}

async function waitForDrain(response: http.ServerResponse): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			response.off("drain", onDrain);
			response.off("close", onClose);
			response.off("error", onError);
		};
		const onDrain = () => {
			cleanup();
			resolve();
		};
		const onClose = () => {
			cleanup();
			reject(new Error("Claude Code disconnected from the turn relay"));
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		response.once("drain", onDrain);
		response.once("close", onClose);
		response.once("error", onError);
	});
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const rawChunk of request) chunks.push(toBuffer(rawChunk));
	return Buffer.concat(chunks);
}
