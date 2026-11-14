import { afterEach, describe, expect, it } from "vitest";

import type { HonoServerHandle } from "../../../shared/hono-server";
import type { AcceptedConversationEvent } from "../../conversation/domain/conversation-session";
import { startHttpEventServer } from "../../http/adapters/http-event-server";
import { HttpEventService } from "../../http/application/http-event-service";
import { HttpResponseRegistry } from "../../http/application/http-response-registry";
import { AssistResponseRegistry } from "../application/assist-response-registry";
import { AssistService } from "../application/assist-service";
import { ASSIST_ROUTE_PATH, registerAssistRoute } from "./assist-route";

const servers: HonoServerHandle[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map(async (server) => await server.close()));
});

const REQUEST = {
	text: "電気消して",
	language: "ja",
	conversation_id: "conv-1",
	device_id: "device-1",
	satellite_id: null,
	device_name: null,
	area_name: null,
	user_name: null,
};

describe("registerAssistRoute", () => {
	it("assist_respondの読み上げ文とcontinue_conversationを200で返す", async () => {
		const { url } = await start({
			onAccept: (input, responses) => {
				responses.respond(input.event.id, "消したよ", true);
			},
		});

		const response = await post(url, REQUEST);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ speech: "消したよ", continue_conversation: true });
	});

	it("返答なしで実行が終わったらspeechをnullで返す", async () => {
		const { url } = await start({
			onAccept: (input, responses) => {
				responses.complete(input.event.id, true);
			},
		});

		const response = await post(url, REQUEST);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ speech: null, continue_conversation: false });
	});

	it("実行が失敗したら500を返す", async () => {
		const { url } = await start({
			onAccept: (input, responses) => {
				responses.complete(input.event.id, false);
			},
		});

		const response = await post(url, REQUEST);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "execution_failed" });
	});

	it("受付停止中は503を返す", async () => {
		const { service, url } = await start({});
		service.stopIntake();

		const response = await post(url, REQUEST);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "unavailable" });
	});

	it.each([
		["textが空", { ...REQUEST, text: "" }],
		["未知のキー", { ...REQUEST, extra: true }],
		["conversation_idの欠落", { ...REQUEST, conversation_id: undefined }],
	])("スキーマに合わない入力(%s)は400を返す", async (_label, body) => {
		const { url } = await start({});

		const response = await post(url, body);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_request" });
	});

	it("JSONとして読めない本文は400、JSON以外のContent-Typeは415を返す", async () => {
		const { url } = await start({});

		const invalid = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		const text = await fetch(url, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: "hello",
		});

		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toEqual({ error: "invalid_json" });
		expect(text.status).toBe(415);
	});
});

async function start(options: {
	onAccept?: (input: AcceptedConversationEvent, responses: AssistResponseRegistry) => void;
}) {
	const responses = new AssistResponseRegistry();
	const service = new AssistService({
		conversation: {
			accept: (input) => {
				queueMicrotask(() => options.onAccept?.(input, responses));
				return true;
			},
		},
		createId: () => crypto.randomUUID(),
		now: () => new Date(),
		responses,
	});
	const server = await startHttpEventServer({
		hostname: "127.0.0.1",
		port: 0,
		service: new HttpEventService({
			conversation: { accept: () => true },
			executor: { execute: async () => ({ status: "completed" }) },
			responses: new HttpResponseRegistry(),
		}),
		onError: () => {},
		configure: (app) => registerAssistRoute(app, service),
	});
	servers.push(server);
	return { service, url: `http://127.0.0.1:${String(server.port)}${ASSIST_ROUTE_PATH}` };
}

async function post(url: string, body: unknown): Promise<Response> {
	return await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}
