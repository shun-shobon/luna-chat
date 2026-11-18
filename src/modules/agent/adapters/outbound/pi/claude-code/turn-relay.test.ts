import * as http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { AnthropicStreamEvent } from "./native-types";
import { describeFailure, TurnRelay } from "./turn-relay";

const servers: http.Server[] = [];
const relays: TurnRelay[] = [];

afterEach(async () => {
	await Promise.all(
		relays.splice(0).map(async (relay) => {
			await relay.close();
		}),
	);
	await Promise.all(
		servers.splice(0).map(
			async (server) =>
				await new Promise<void>((resolve) => {
					server.close(() => {
						resolve();
					});
				}),
		),
	);
});

async function upstream(handler: http.RequestListener): Promise<string> {
	const server = http.createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address == null || typeof address === "string") throw new Error("missing address");
	return `http://127.0.0.1:${address.port}`;
}

function relayFor(
	url: string,
	onEvent?: (event: AnthropicStreamEvent) => void,
	transform?: (body: Buffer) => Buffer,
	betas?: string[],
): TurnRelay {
	const relay = new TurnRelay(url, 5000, onEvent, transform, betas);
	relays.push(relay);
	return relay;
}

async function drain(request: http.IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of request) body += String(chunk);
	return body;
}

const usage = { input_tokens: 2, output_tokens: 1 };
const sse = (events: unknown[]) =>
	events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

describe("TurnRelay", () => {
	it("上流への要求を1回だけ中継し、SSE の応答を捕まえる", async () => {
		const bodies: string[] = [];
		const betas: string[] = [];
		const url = await upstream((request, response) => {
			void drain(request).then((body) => {
				bodies.push(body);
				betas.push(String(request.headers["anthropic-beta"] ?? ""));
				response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_test" });
				response.end(
					sse([
						{ type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } },
						{ type: "ping" },
						{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
						{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
						{ type: "content_block_delta", index: 0, delta: { type: "citations_delta" } },
						{ type: "content_block_stop", index: 0 },
						{
							type: "message_delta",
							delta: { stop_reason: "end_turn" },
							usage: { output_tokens: 5, input_tokens: null },
						},
						{ type: "message_stop" },
					]),
				);
			});
		});
		const observed: string[] = [];
		const relay = relayFor(
			url,
			(event) => observed.push(event.type),
			(body) => {
				const parsed: unknown = JSON.parse(body.toString("utf8"));
				return Buffer.from(JSON.stringify({ original: parsed, rewritten: true }));
			},
			["native-tools-test"],
		);

		const baseUrl = await relay.start();
		const first = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers: { "anthropic-beta": "existing-test" },
			body: "{}",
		});
		expect(first.status).toBe(200);
		await first.text();
		const second = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" });
		expect(second.status).toBe(400);
		await second.text();
		await relay.settled();

		expect(bodies.map((body): unknown => JSON.parse(body))).toEqual([
			{ original: {}, rewritten: true },
		]);
		expect(relay.originalRequestBody?.toString("utf8")).toBe("{}");
		expect(betas).toEqual(["existing-test,native-tools-test"]);
		expect(relay.used).toBe(true);
		expect(relay.denied).toBe(1);
		expect(relay.capture.complete).toBe(true);
		expect(relay.capture.message?.content).toEqual([{ type: "text", text: "hello" }]);
		expect(relay.capture.message?.usage).toEqual({ input_tokens: 2, output_tokens: 5 });
		expect(relay.requestId).toBe("req_test");
		expect(observed).not.toContain("ping");
		expect(observed.at(-1)).toBe("message_stop");

		relay.finishTurn();
		const nextObserved: string[] = [];
		relay.beginTurn((event) => nextObserved.push(event.type));
		const next = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: '{"turn":2}' });
		expect(next.status).toBe(200);
		await next.text();
		await relay.settled();
		expect(bodies[1]).toBe('{"turn":2}');
		expect(relay.denied).toBe(0);
		expect(relay.capture.complete).toBe(true);
		expect(nextObserved.at(-1)).toBe("message_stop");
	});

	it("ツール引数の JSON を組み立てる", async () => {
		const url = await upstream((request, response) => {
			void drain(request).then(() => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					sse([
						{ type: "message_start", message: { role: "assistant", content: [], usage } },
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "tool_use", id: "t1", name: "mcp__pi__echo", input: {} },
						},
						{
							type: "content_block_delta",
							index: 0,
							delta: { type: "input_json_delta", partial_json: '{"value":' },
						},
						{
							type: "content_block_delta",
							index: 0,
							delta: { type: "input_json_delta", partial_json: '"x"}' },
						},
						{ type: "content_block_stop", index: 0 },
						{ type: "message_delta", delta: { stop_reason: "tool_use" } },
						{ type: "message_stop" },
					]),
				);
			});
		});
		const relay = relayFor(url);
		const baseUrl = await relay.start();
		await (await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" })).text();
		await relay.settled();
		expect(relay.capture.complete).toBe(true);
		expect(relay.capture.message?.content).toEqual([
			{ type: "tool_use", id: "t1", name: "mcp__pi__echo", input: { value: "x" } },
		]);
	});

	it("200 の SSE の途中で届いたエラーを表に出す", async () => {
		const url = await upstream((request, response) => {
			void drain(request).then(() => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					[
						`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } })}\n\n`,
						`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`,
					].join(""),
				);
			});
		});
		const relay = relayFor(url);
		const baseUrl = await relay.start();
		const response = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" });
		expect(response.status).toBe(200);
		await response.text();
		await relay.settled();

		expect(relay.capture.complete).toBe(false);
		expect(relay.errorText()).toBe("overloaded_error: Overloaded");
	});

	it("形の崩れた SSE イベントは中継の失敗として記録する", async () => {
		const url = await upstream((request, response) => {
			void drain(request).then(() => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(sse([{ type: "message_start", message: { role: "user" } }]));
			});
		});
		const relay = relayFor(url);
		const baseUrl = await relay.start();
		await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" })
			.then(async (response) => await response.text())
			.catch(() => "");
		await relay.settled();

		expect(relay.capture.complete).toBe(false);
		expect(relay.failure).toMatch(/^ZodError/u);
		expect(relay.upstreamFailed).toBe(false);
	});

	it("4xx の本文からエラーの文言を取り出す", async () => {
		const url = await upstream((request, response) => {
			void drain(request).then(() => {
				response
					.writeHead(400, { "content-type": "application/json" })
					.end(JSON.stringify({ type: "error", error: { message: "bad request" } }));
			});
		});
		const relay = relayFor(url);
		const baseUrl = await relay.start();
		expect((await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" })).status).toBe(
			400,
		);
		await relay.settled();
		expect(relay.status).toBe(400);
		expect(relay.errorText()).toBe("bad request");
	});

	it("違うパスやブラウザーからの要求には応えない", async () => {
		const relay = relayFor("https://api.anthropic.com");
		const baseUrl = await relay.start();
		expect((await fetch(`${baseUrl}/v1/other`, { method: "POST", body: "{}" })).status).toBe(404);
		expect(
			(
				await fetch(`${baseUrl}/v1/messages`, {
					method: "POST",
					headers: { origin: "https://example.com" },
					body: "{}",
				})
			).status,
		).toBe(404);
		expect(relay.used).toBe(false);
	});

	it("HTTPS でもループバックでもない上流は断る", () => {
		expect(() => new TurnRelay("http://example.com")).toThrow(
			"Claude Code upstream must be HTTPS or a loopback HTTP fixture",
		);
	});
});

describe("describeFailure", () => {
	it("エラーコードと入れ子のエラーを含めて書く", () => {
		const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
			code: "ECONNREFUSED",
		});
		expect(describeFailure(refused)).toBe("Error: connect ECONNREFUSED 127.0.0.1:1");
		const timeout = Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:443"), {
			code: "ETIMEDOUT",
		});
		const every = Object.assign(new AggregateError([refused, timeout]), { code: "ETIMEDOUT" });
		expect(describeFailure(every)).toBe(
			"AggregateError (ETIMEDOUT) [Error: connect ECONNREFUSED 127.0.0.1:1; Error: connect ETIMEDOUT 10.0.0.1:443]",
		);
		expect(describeFailure(Object.assign(new Error(""), { code: "ECONNRESET" }))).toBe(
			"Error (ECONNRESET)",
		);
		expect(describeFailure("nope")).toBe("UnknownError");
	});
});
