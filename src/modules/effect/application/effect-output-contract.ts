import { z } from "zod";

import { type JsonValue, jsonValueSchema } from "../../event/domain/luna-event";
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
          let input: JsonValue;
          try {
            input = registry.getDefinition(effect.type).parseInput(effect.input);
          } catch (error: unknown) {
            throw new EffectOutputParseError(
              `Invalid effect ${effect.type}: ${toErrorMessage(error)}`,
              { cause: error },
            );
          }
          return { type: effect.type, input };
        }),
      };
    },
  });
}

function createOutputJsonSchema(registry: EffectRegistry): Record<string, unknown> {
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
  assertStructuredOutputSchema(schema);
  return Object.freeze(schema);
}

function withoutDialect(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema };
  delete result["$schema"];
  return result;
}

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "additionalProperties",
  "anyOf",
  "const",
  "description",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maximum",
  "maxItems",
  "minimum",
  "minItems",
  "multipleOf",
  "pattern",
  "properties",
  "required",
  "type",
]);

function assertStructuredOutputSchema(value: unknown, path = "outputSchema"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertStructuredOutputSchema(item, `${path}[${String(index)}]`));
    return;
  }
  if (!isRecord(value)) return;

  for (const keyword of Object.keys(value)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      throw new Error(`${path} contains unsupported JSON Schema keyword: ${keyword}`);
    }
  }

  if (value["type"] === "object") {
    if (value["additionalProperties"] !== false) {
      throw new Error(`${path} must set additionalProperties to false.`);
    }
    const properties = value["properties"];
    const required = value["required"];
    if (!isRecord(properties) || !Array.isArray(required)) {
      throw new Error(`${path} must define object properties and required fields.`);
    }
    const requiredFields = z.array(z.string()).parse(required);
    if (
      requiredFields.length !== Object.keys(properties).length ||
      Object.keys(properties).some((property) => !requiredFields.includes(property))
    ) {
      throw new Error(`${path} must require every object property.`);
    }
  }

  const properties = value["properties"];
  if (isRecord(properties)) {
    for (const [property, propertySchema] of Object.entries(properties)) {
      assertStructuredOutputSchema(propertySchema, `${path}.properties.${property}`);
    }
  }
  if (value["items"] !== undefined) {
    assertStructuredOutputSchema(value["items"], `${path}.items`);
  }
  if (value["anyOf"] !== undefined) {
    assertStructuredOutputSchema(value["anyOf"], `${path}.anyOf`);
  }
  const definitions = value["$defs"];
  if (isRecord(definitions)) {
    for (const [name, definition] of Object.entries(definitions)) {
      assertStructuredOutputSchema(definition, `${path}.$defs.${name}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
