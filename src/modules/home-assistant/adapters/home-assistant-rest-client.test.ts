import { describe, expect, it, vi } from "vitest";

import { HomeAssistantRequestError, HomeAssistantRestClient } from "./home-assistant-rest-client";

const BASE_URL = new URL("http://192.168.0.104:8123");

describe("HomeAssistantRestClient", () => {
	it("Bearerトークン付きで/api/statesを取得し、状態を内部の形に変換する", async () => {
		const { client, requests } = createClient(() => json([rawState("light.kitchen", "on")]));

		const states = await client.listStates(new AbortController().signal);

		expect(requests[0]?.url).toBe("http://192.168.0.104:8123/api/states");
		expect(requests[0]?.init.method).toBe("GET");
		expect(requests[0]?.init.headers).toEqual({ authorization: "Bearer secret" });
		expect(states).toEqual([
			{
				entityId: "light.kitchen",
				state: "on",
				attributes: { friendly_name: "light.kitchen" },
				lastChanged: "2026-11-14T00:00:00.000Z",
				lastUpdated: "2026-11-14T00:00:01.000Z",
			},
		]);
	});

	it("getStateはエンティティIDをパスに入れ、404ならundefinedを返す", async () => {
		const { client, requests } = createClient(() => new Response("not found", { status: 404 }));

		await expect(client.getState("light.kitchen", new AbortController().signal)).resolves.toBe(
			undefined,
		);
		expect(requests[0]?.url).toBe("http://192.168.0.104:8123/api/states/light.kitchen");
	});

	it("2xx以外は応答本文を含むエラーにする", async () => {
		const { client } = createClient(
			() => new Response('{"message":"Entity not found"}', { status: 400 }),
		);

		await expect(client.listStates(new AbortController().signal)).rejects.toThrow(
			new HomeAssistantRequestError(
				'Home Assistant returned HTTP 400 for GET /api/states: {"message":"Entity not found"}',
			),
		);
	});

	it("接続の失敗はHomeAssistantRequestErrorにして元の例外をcauseに持つ", async () => {
		const failure = new TypeError("fetch failed");
		const { client } = createClient(() => {
			throw failure;
		});

		const error = await client
			.listStates(new AbortController().signal)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(HomeAssistantRequestError);
		expect(error).toMatchObject({
			message: "Home Assistant request failed: GET /api/states.",
			cause: failure,
		});
	});

	it("呼び出し元のsignalを中断するとリクエストを打ち切って失敗にする", async () => {
		const controller = new AbortController();
		const { client } = createClient(
			async (_url, init) =>
				await new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);

		const pending = client.listStates(controller.signal);
		controller.abort(new Error("aborted"));

		await expect(pending).rejects.toThrow("Home Assistant request failed: GET /api/states.");
	});

	it("スキーマに合わない応答はエラーにする", async () => {
		const { client } = createClient(() => json([{ entity_id: "light.kitchen" }]));

		await expect(client.listStates(new AbortController().signal)).rejects.toThrow(
			"Home Assistant returned an unexpected response for /api/states",
		);
	});

	it("JSONでない応答本文はHomeAssistantRequestErrorにする", async () => {
		const { client } = createClient(() => new Response("<html>", { status: 200 }));

		await expect(client.listStates(new AbortController().signal)).rejects.toThrow(
			new HomeAssistantRequestError("Home Assistant returned invalid JSON for /api/states."),
		);
	});

	it("callServiceはdataをJSONで送り、変化した状態を返す", async () => {
		const { client, requests } = createClient(() => json([rawState("light.kitchen", "off")]));

		const result = await client.callService(
			{
				domain: "light",
				service: "turn_off",
				data: { entity_id: "light.kitchen", transition: 2 },
				returnResponse: false,
			},
			new AbortController().signal,
		);

		expect(requests[0]?.url).toBe("http://192.168.0.104:8123/api/services/light/turn_off");
		expect(requests[0]?.init).toMatchObject({
			method: "POST",
			headers: { authorization: "Bearer secret", "content-type": "application/json" },
			body: JSON.stringify({ entity_id: "light.kitchen", transition: 2 }),
		});
		expect(result.changedStates.map((state) => state.state)).toEqual(["off"]);
		expect(result.serviceResponse).toBeUndefined();
	});

	it("return_responseならクエリを付け、service_responseを返す", async () => {
		const { client, requests } = createClient(() =>
			json({
				changed_states: [],
				service_response: { "weather.home": { forecast: [{ temperature: 20 }] } },
			}),
		);

		const result = await client.callService(
			{ domain: "weather", service: "get_forecasts", data: {}, returnResponse: true },
			new AbortController().signal,
		);

		expect(requests[0]?.url).toBe(
			"http://192.168.0.104:8123/api/services/weather/get_forecasts?return_response",
		);
		expect(result).toEqual({
			changedStates: [],
			serviceResponse: { "weather.home": { forecast: [{ temperature: 20 }] } },
		});
	});

	it("listServicesは説明とフィールドの説明だけに縮める", async () => {
		const { client } = createClient(() =>
			json([
				{
					domain: "light",
					services: {
						turn_on: {
							name: "Turn on",
							description: "Turn on a light.",
							fields: {
								brightness_pct: { description: "Brightness.", selector: { number: {} } },
								advanced_fields: { collapsed: true, fields: {} },
							},
							target: { entity: [{ domain: ["light"] }] },
						},
						toggle: {},
					},
				},
			]),
		);

		const domains = await client.listServices(new AbortController().signal);

		expect(domains).toEqual([
			{
				domain: "light",
				services: {
					turn_on: {
						description: "Turn on a light.",
						fields: { brightness_pct: "Brightness.", advanced_fields: null },
					},
					toggle: { fields: {} },
				},
			},
		]);
	});
});

type RecordedRequest = { url: string; init: RequestInit };

function createClient(respond: (url: string, init: RequestInit) => Response | Promise<Response>): {
	client: HomeAssistantRestClient;
	requests: RecordedRequest[];
} {
	const requests: RecordedRequest[] = [];
	const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : input.toString();
		const requestInit = init ?? {};
		requests.push({ url, init: requestInit });
		return await respond(url, requestInit);
	});
	return {
		client: new HomeAssistantRestClient({ baseUrl: BASE_URL, token: "secret", fetch: fakeFetch }),
		requests,
	};
}

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function rawState(entityId: string, state: string) {
	return {
		entity_id: entityId,
		state,
		attributes: { friendly_name: entityId },
		last_changed: "2026-11-14T00:00:00.000Z",
		last_updated: "2026-11-14T00:00:01.000Z",
		context: { id: "ctx" },
	};
}
