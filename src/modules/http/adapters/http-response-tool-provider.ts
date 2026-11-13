import { z } from "zod";

import { jsonValueSchema } from "../../../shared/json";
import { defineTool } from "../../tool/ports/tool-provider";
import type { ToolProvider } from "../../tool/ports/tool-provider";
import type { HttpResponseRegistry } from "../application/http-response-registry";

const responseInputSchema = z.strictObject({
	request_id: z.uuid(),
	status: z
		.number()
		.int()
		.min(200)
		.max(599)
		.refine((status) => ![204, 205, 304].includes(status), "Status must allow a response body"),
	body_json: z.string(),
});

export function createHttpResponseToolProvider(registry: HttpResponseRegistry): ToolProvider {
	return Object.freeze({
		definitions: Object.freeze([
			defineTool({
				name: "http_respond",
				description:
					"Set the JSON response for an HTTP event whose response_mode is wait. request_id is the event id and body_json is serialized JSON. The response is sent when the run finishes.",
				inputSchema: responseInputSchema,
				parseInput: (input) => ({
					request_id: input.request_id,
					status: input.status,
					body: jsonValueSchema.parse(JSON.parse(input.body_json)),
				}),
				execute: (input) => {
					registry.record(input.request_id, input.status, input.body);
					return Promise.resolve({ request_id: input.request_id });
				},
				describeTarget: (input) => ({ request_id: input.request_id }),
			}),
		]),
		release: async () => {},
	});
}
