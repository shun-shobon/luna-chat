import { z } from "zod";

import { defineEffect, type EffectProvider } from "../../effect/ports/effect-provider";
import { jsonValueSchema } from "../../event/domain/luna-event";
import type { HttpResponseRegistry } from "../application/http-response-registry";

const HTTP_RESPOND_EFFECT_TYPE = "http.respond";

const responseAgentInputSchema = z.strictObject({
  request_id: z.uuid(),
  status: z
    .number()
    .int()
    .min(200)
    .max(599)
    .refine((status) => ![204, 205, 304].includes(status)),
  body_json: z.string(),
});

const responseInputSchema = z.strictObject({
  request_id: z.uuid(),
  status: z
    .number()
    .int()
    .min(200)
    .max(599)
    .refine((status) => ![204, 205, 304].includes(status)),
  body: jsonValueSchema,
});

export function createHttpResponseEffectProvider(registry: HttpResponseRegistry): EffectProvider {
  return Object.freeze({
    definitions: Object.freeze([
      defineEffect({
        type: HTTP_RESPOND_EFFECT_TYPE,
        agentInputSchema: responseAgentInputSchema,
        inputSchema: responseInputSchema,
        parseInput: (input) => ({
          request_id: input.request_id,
          status: input.status,
          body: jsonValueSchema.parse(JSON.parse(input.body_json)),
        }),
        execute: async (input) => {
          registry.record(input.request_id, input.status, input.body);
          return { request_id: input.request_id };
        },
        describeTarget: (input) => ({ request_id: input.request_id }),
      }),
    ]),
    release: async () => {},
  });
}
