import { z } from "zod";

import { jsonObjectSchema, jsonValueSchema } from "../../../shared/json";
import type { JsonObject } from "../../../shared/json";
import type { EffectOutput } from "../domain/effect";
import type { EffectOutputContract } from "../ports/effect-output-contract";
import type { EffectRegistry } from "./effect-registry";

const effectEnvelopeSchema = z.strictObject({
	effects: z.array(
		z.strictObject({
			type: z.string(),
			input: jsonValueSchema,
		}),
	),
});

class EffectOutputParseError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "EffectOutputParseError";
	}
}

export function createEffectOutputContract(registry: EffectRegistry): EffectOutputContract {
	const jsonSchema = createOutputJsonSchema(registry);

	return Object.freeze({
		jsonSchema,
		parse: (text: string): EffectOutput => {
			let value: unknown;
			try {
				value = JSON.parse(text);
			} catch (error: unknown) {
				throw new EffectOutputParseError("Effect output is not valid JSON.", { cause: error });
			}

			const envelope = effectEnvelopeSchema.safeParse(value);
			if (!envelope.success) {
				throw new EffectOutputParseError(z.prettifyError(envelope.error));
			}

			return {
				effects: envelope.data.effects.map((effect) => {
					try {
						return registry.getDefinition(effect.type).parse(effect.input);
					} catch (error: unknown) {
						throw new EffectOutputParseError(
							`Invalid effect ${effect.type}: ${toErrorMessage(error)}`,
							{ cause: error },
						);
					}
				}),
			};
		},
	});
}

function createOutputJsonSchema(registry: EffectRegistry): JsonObject {
	const schema = {
		type: "object",
		properties: {
			effects: {
				type: "array",
				items: {
					anyOf: registry.definitions.map((definition) => ({
						type: "object",
						properties: {
							type: { type: "string", const: definition.type },
							input: withoutDialect(z.toJSONSchema(definition.agentInputSchema)),
						},
						required: ["type", "input"],
						additionalProperties: false,
					})),
				},
			},
		},
		required: ["effects"],
		additionalProperties: false,
	};
	// z.toJSONSchema is typed with unknown members, so parse once here to hand Codex a typed JSON object.
	return Object.freeze(jsonObjectSchema.parse(schema));
}

function withoutDialect(schema: Record<string, unknown>): Record<string, unknown> {
	const result = { ...schema };
	delete result["$schema"];
	return result;
}

function toErrorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}
