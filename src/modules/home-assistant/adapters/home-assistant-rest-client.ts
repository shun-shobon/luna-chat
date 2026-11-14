import { z } from "zod";

import { jsonValueSchema } from "../../../shared/json";
import type { HomeAssistantState } from "../domain/state-change";
import type {
	HomeAssistantRestPort,
	HomeAssistantServiceCall,
	HomeAssistantServiceDomain,
	HomeAssistantServiceResult,
} from "../ports/home-assistant-api-port";

// HAは同じLANにあり、これを超える応答待ちは接続の異常として扱う。
const REQUEST_TIMEOUT_MS = 15_000;
const ERROR_BODY_MAX_LENGTH = 2_000;

export const homeAssistantStateSchema = z
	.looseObject({
		entity_id: z.string(),
		state: z.string(),
		attributes: z.record(z.string(), z.unknown()),
		last_changed: z.string(),
		last_updated: z.string(),
	})
	.transform((state): HomeAssistantState => ({
		entityId: state.entity_id,
		state: state.state,
		attributes: state.attributes,
		lastChanged: state.last_changed,
		lastUpdated: state.last_updated,
	}));

const servicesSchema = z.array(
	z.looseObject({
		domain: z.string(),
		services: z.record(
			z.string(),
			z.looseObject({
				description: z.string().optional(),
				fields: z
					.record(z.string(), z.looseObject({ description: z.string().optional() }))
					.optional(),
			}),
		),
	}),
);

const changedStatesSchema = z.array(homeAssistantStateSchema);
const serviceResponseSchema = z.looseObject({
	changed_states: changedStatesSchema,
	service_response: jsonValueSchema,
});

export class HomeAssistantRequestError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "HomeAssistantRequestError";
	}
}

export class HomeAssistantRestClient implements HomeAssistantRestPort {
	constructor(
		private readonly connection: Readonly<{
			baseUrl: URL;
			token: string;
			fetch: typeof globalThis.fetch;
		}>,
	) {}

	async listStates(signal: AbortSignal): Promise<readonly HomeAssistantState[]> {
		const response = await this.#request("GET", "/api/states", undefined, signal);
		return parseResponse(
			z.array(homeAssistantStateSchema),
			await readJson(response, "/api/states"),
			"/api/states",
		);
	}

	async getState(entityId: string, signal: AbortSignal): Promise<HomeAssistantState | undefined> {
		const path = `/api/states/${encodeURIComponent(entityId)}`;
		const response = await this.#request("GET", path, undefined, signal, [404]);
		if (response.status === 404) return undefined;
		return parseResponse(homeAssistantStateSchema, await readJson(response, path), path);
	}

	async listServices(signal: AbortSignal): Promise<readonly HomeAssistantServiceDomain[]> {
		const response = await this.#request("GET", "/api/services", undefined, signal);
		const domains = parseResponse(
			servicesSchema,
			await readJson(response, "/api/services"),
			"/api/services",
		);
		return domains.map((entry) => ({
			domain: entry.domain,
			services: Object.fromEntries(
				Object.entries(entry.services).map(([name, service]) => [
					name,
					{
						...(service.description === undefined ? {} : { description: service.description }),
						fields: Object.fromEntries(
							Object.entries(service.fields ?? {}).map(([field, value]) => [
								field,
								value.description ?? null,
							]),
						),
					},
				]),
			),
		}));
	}

	async callService(
		call: HomeAssistantServiceCall,
		signal: AbortSignal,
	): Promise<HomeAssistantServiceResult> {
		const path = `/api/services/${encodeURIComponent(call.domain)}/${encodeURIComponent(call.service)}${call.returnResponse ? "?return_response" : ""}`;
		const response = await this.#request("POST", path, call.data, signal);
		const body = await readJson(response, path);
		if (call.returnResponse) {
			const result = parseResponse(serviceResponseSchema, body, path);
			return { changedStates: result.changed_states, serviceResponse: result.service_response };
		}
		return {
			changedStates: parseResponse(changedStatesSchema, body, path),
			serviceResponse: undefined,
		};
	}

	async #request(
		method: "GET" | "POST",
		path: string,
		body: unknown,
		signal: AbortSignal,
		acceptedStatuses: readonly number[] = [],
	): Promise<Response> {
		const url = new URL(path, this.connection.baseUrl);
		let response: Response;
		try {
			response = await this.connection.fetch(url, {
				method,
				headers: {
					authorization: `Bearer ${this.connection.token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
			});
		} catch (error: unknown) {
			throw new HomeAssistantRequestError(`Home Assistant request failed: ${method} ${path}.`, {
				cause: error,
			});
		}
		if (response.ok || acceptedStatuses.includes(response.status)) return response;
		const detail = (await response.text().catch(() => "")).slice(0, ERROR_BODY_MAX_LENGTH);
		throw new HomeAssistantRequestError(
			`Home Assistant returned HTTP ${response.status} for ${method} ${path}: ${detail}`,
		);
	}
}

async function readJson(response: Response, path: string): Promise<unknown> {
	try {
		return await response.json();
	} catch (error: unknown) {
		throw new HomeAssistantRequestError(`Home Assistant returned invalid JSON for ${path}.`, {
			cause: error,
		});
	}
}

function parseResponse<T>(schema: z.ZodType<T>, body: unknown, path: string): T {
	const result = schema.safeParse(body);
	if (!result.success) {
		throw new HomeAssistantRequestError(
			`Home Assistant returned an unexpected response for ${path}: ${z.prettifyError(result.error)}`,
		);
	}
	return result.data;
}
