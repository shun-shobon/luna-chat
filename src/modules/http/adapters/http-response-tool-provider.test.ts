import { describe, expect, it, vi } from "vitest";

import type { AgentTool } from "../../agent/ports/outbound/agent-session-port";
import { createToolSet } from "../../tool/application/tool-set";
import { HttpResponseRegistry } from "../application/http-response-registry";
import { createHttpResponseToolProvider } from "./http-response-tool-provider";

const REQUEST_ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

describe("http_respond tool", () => {
	it("待機中のHTTP要求へstatusとJSON本文を記録し、実行完了時に応答する", async () => {
		const registry = new HttpResponseRegistry();
		const outcome = registry.register(REQUEST_ID);
		const respond = bindRespond(registry);

		await expect(
			respond.execute(
				{ request_id: REQUEST_ID, status: 201, body_json: '{"ok":true,"items":[1]}' },
				new AbortController().signal,
			),
		).resolves.toEqual({
			text: JSON.stringify({ request_id: REQUEST_ID }),
			images: [],
			isError: false,
		});
		registry.complete(REQUEST_ID, true);

		await expect(outcome).resolves.toEqual({
			kind: "response",
			status: 201,
			body: { ok: true, items: [1] },
		});
	});

	it.each([
		["JSONでないbody_json", { request_id: REQUEST_ID, status: 200, body_json: "{" }],
		["本文を持てないstatus", { request_id: REQUEST_ID, status: 204, body_json: "null" }],
		["範囲外のstatus", { request_id: REQUEST_ID, status: 600, body_json: "null" }],
		["UUIDでないrequest_id", { request_id: "event-1", status: 200, body_json: "null" }],
		["未知のfield", { request_id: REQUEST_ID, status: 200, body_json: "null", body: {} }],
	])("%sは記録せずにisErrorを返す", async (_label, input) => {
		const registry = new HttpResponseRegistry();
		const outcome = registry.register(REQUEST_ID);

		await expect(
			bindRespond(registry).execute(input, new AbortController().signal),
		).resolves.toMatchObject({ isError: true });
		registry.complete(REQUEST_ID, true);

		await expect(outcome).resolves.toEqual({ kind: "no_content" });
	});

	it("待機していない要求と二重の応答をisErrorとして返す", async () => {
		const registry = new HttpResponseRegistry();
		void registry.register(REQUEST_ID);
		const respond = bindRespond(registry);
		const input = { request_id: REQUEST_ID, status: 200, body_json: "1" };

		await expect(respond.execute(input, new AbortController().signal)).resolves.toMatchObject({
			isError: false,
		});
		await expect(respond.execute(input, new AbortController().signal)).resolves.toEqual({
			text: `HTTP request already has a response: ${REQUEST_ID}`,
			images: [],
			isError: true,
		});
		const otherId = "00000000-0000-4000-8000-000000000000";
		await expect(
			respond.execute({ ...input, request_id: otherId }, new AbortController().signal),
		).resolves.toMatchObject({ text: `HTTP request is not waiting: ${otherId}`, isError: true });
	});
});

function bindRespond(registry: HttpResponseRegistry): AgentTool {
	const [tool] = createToolSet([createHttpResponseToolProvider(registry)], { log: vi.fn() }).bind({
		ownerId: "owner-1",
		origin: { kind: "event", eventId: REQUEST_ID, eventType: "http.request.v1" },
	});
	if (tool === undefined) throw new Error("http_respond tool is missing");
	return tool;
}
