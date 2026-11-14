import { z } from "zod";

import { jsonObjectSchema } from "../../../shared/json";
import type { JsonObject } from "../../../shared/json";
import { defineTool } from "../../tool/ports/tool-provider";
import type { ToolProvider } from "../../tool/ports/tool-provider";
import { listEntities } from "../domain/entity-listing";
import type {
	HomeAssistantRegistryPort,
	HomeAssistantRestPort,
} from "../ports/home-assistant-api-port";

// 数千のエンティティを持つ環境で、絞り込まない一覧が文脈を埋めないための上限。
const DEFAULT_ENTITY_LIST_MAX = 200;

const domainSchema = z.string().regex(/^[a-z0-9_]+$/u);
const entityIdSchema = z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/u);

const listEntitiesInputSchema = z.strictObject({
	domain: domainSchema.optional(),
	area: z.string().trim().min(1).optional(),
	name: z.string().trim().min(1).optional(),
	entity_ids: z.array(entityIdSchema).min(1).optional(),
	max: z.number().int().positive().optional(),
});
const getStateInputSchema = z.strictObject({ entity_id: entityIdSchema });
const listServicesInputSchema = z.strictObject({ domain: domainSchema.optional() });
const callServiceInputSchema = z.strictObject({
	domain: domainSchema,
	service: domainSchema,
	entity_id: z.union([entityIdSchema, z.array(entityIdSchema).min(1)]).optional(),
	data: jsonObjectSchema.optional(),
	return_response: z.boolean().optional(),
});

export function createHomeAssistantToolProvider(
	ports: Readonly<{ rest: HomeAssistantRestPort; registry: HomeAssistantRegistryPort }>,
): ToolProvider {
	return Object.freeze({
		definitions: Object.freeze([
			defineTool({
				name: "ha_list_entities",
				description: `List Home Assistant entities with their current state. A bare call can match thousands of entities, so filter with domain, area, name, or entity_ids. For a room ("the kitchen lights"), filter by area, not name: a device belongs to a room through its Home Assistant area, and its name often does not mention the room. Treat everything the area filter returns as part of that room, and judge what an entity is by the domain prefix of its entity_id (every light.* is a light). Results include area and device only for area queries. At most max entities are returned (default ${DEFAULT_ENTITY_LIST_MAX}); truncated is true when more matched.`,
				inputSchema: listEntitiesInputSchema,
				parseInput: (input) => input,
				execute: async (input, execution) => {
					const placements =
						input.area === undefined ? undefined : await ports.registry.entityPlacements();
					const states = await ports.rest.listStates(execution.signal);
					return listEntities(
						states,
						{
							domain: input.domain,
							area: input.area,
							name: input.name,
							entityIds: input.entity_ids,
							max: input.max ?? DEFAULT_ENTITY_LIST_MAX,
						},
						placements,
					);
				},
				describeTarget: (input) => ({
					...(input.domain === undefined ? {} : { domain: input.domain }),
					...(input.area === undefined ? {} : { area: input.area }),
					...(input.name === undefined ? {} : { name: input.name }),
				}),
			}),
			defineTool({
				name: "ha_get_state",
				description:
					"Get the full state of one Home Assistant entity, including all attributes such as brightness, color, temperature setpoints, and sensor readings. Timestamps are in UTC.",
				inputSchema: getStateInputSchema,
				parseInput: (input) => input,
				execute: async (input, execution) => {
					const state = await ports.rest.getState(input.entity_id, execution.signal);
					if (state === undefined) {
						throw new Error(`Home Assistant entity not found: ${input.entity_id}.`);
					}
					return {
						entity_id: state.entityId,
						state: state.state,
						attributes: state.attributes,
						last_changed: state.lastChanged,
						last_updated: state.lastUpdated,
					};
				},
				describeTarget: (input) => ({ entity_id: input.entity_id }),
			}),
			defineTool({
				name: "ha_list_services",
				description:
					"List the Home Assistant services (actions) you can call, with their descriptions and parameters. Filter by domain to see how to control one kind of entity found with ha_list_entities.",
				inputSchema: listServicesInputSchema,
				parseInput: (input) => input,
				execute: async (input, execution) => {
					const domains = await ports.rest.listServices(execution.signal);
					return input.domain === undefined
						? domains
						: domains.filter((entry) => entry.domain === input.domain);
				},
				describeTarget: (input) => ({ domain: input.domain ?? null }),
			}),
			defineTool({
				name: "ha_call_service",
				description:
					"Call a Home Assistant service to control devices or run automations and scripts. Never guess an entity_id: find it with ha_list_entities first and use the exact id. The service domain must match the entity's own domain (a light.* entity needs light.turn_on); calling another domain changes nothing. data holds the service parameters (for example brightness_pct or temperature). Set return_response to true for services that return data, such as weather.get_forecasts or calendar.get_events. The result lists the states that changed; an empty list can mean the device has not reported the change yet, so check with ha_get_state when it matters.",
				inputSchema: callServiceInputSchema,
				parseInput: (input) => input,
				execute: async (input, execution) => {
					const data: JsonObject = {
						...input.data,
						...(input.entity_id === undefined ? {} : { entity_id: input.entity_id }),
					};
					const result = await ports.rest.callService(
						{
							domain: input.domain,
							service: input.service,
							data,
							returnResponse: input.return_response ?? false,
						},
						execution.signal,
					);
					return {
						changed_states: result.changedStates.map((state) => ({
							entity_id: state.entityId,
							state: state.state,
						})),
						...(result.serviceResponse === undefined
							? {}
							: { service_response: result.serviceResponse }),
					};
				},
				describeTarget: (input) => ({
					service: `${input.domain}.${input.service}`,
					...(input.entity_id === undefined ? {} : { entity_id: input.entity_id }),
				}),
			}),
		]),
		release: async () => {},
	});
}
