import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { JsonValue } from "../../event/domain/luna-event";
import type { EffectProvider } from "../ports/effect-provider";
import { defineEffect } from "../ports/effect-provider";

import { createEffectOutputContract } from "./effect-output-contract";
import { createEffectRegistry } from "./effect-registry";

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

const recordInputSchema = z.strictObject({
  target: z.string(),
  value: z.string(),
});

function createProvider(
  type = "fake.record",
  execute: (
    input: z.infer<typeof recordInputSchema>,
    ownerId: string,
  ) => Promise<JsonValue> = async (input) => input,
): EffectProvider {
  return {
    definitions: [
      defineEffect({
        type,
        agentInputSchema: recordInputSchema,
        inputSchema: recordInputSchema,
        parseInput: (input) => input,
        execute,
        describeTarget: (input) => input.target,
      }),
    ],
    release: async () => {},
  };
}

describe("createEffectOutputContract", () => {
  it("登録済みdefinitionからCodex JSON Schema subsetのschemaを作る", () => {
    const contract = createEffectOutputContract(createEffectRegistry([createProvider()]));

    expect(contract.jsonSchema).not.toHaveProperty("properties.effects.items.oneOf");
    validateStructuredOutputSchema(contract.jsonSchema);
  });

  it("空のeffectsを受理する", () => {
    const contract = createEffectOutputContract(createEffectRegistry([createProvider()]));

    expect(contract.parse('{"effects":[]}')).toEqual({ effects: [] });
  });

  it("登録済みEffectをparseする", () => {
    const contract = createEffectOutputContract(createEffectRegistry([createProvider()]));

    expect(
      contract.parse(
        JSON.stringify({
          effects: [{ type: "fake.record", input: { target: "audit", value: "first" } }],
        }),
      ),
    ).toEqual({
      effects: [{ type: "fake.record", input: { target: "audit", value: "first" } }],
    });
  });

  it("複数種類のEffectをparseする", () => {
    const contract = createEffectOutputContract(
      createEffectRegistry([createProvider(), createProvider("fake.notify")]),
    );

    expect(
      contract
        .parse(
          JSON.stringify({
            effects: [
              { type: "fake.record", input: { target: "audit", value: "first" } },
              { type: "fake.notify", input: { target: "user", value: "second" } },
            ],
          }),
        )
        .effects.map((effect) => effect.type),
    ).toEqual(["fake.record", "fake.notify"]);
  });

  it("Agent入力を実行用inputへ正規化する", () => {
    const provider: EffectProvider = {
      definitions: [
        defineEffect({
          type: "fake.normalize",
          agentInputSchema: z.strictObject({ value: z.string().nullable() }),
          inputSchema: z.strictObject({ value: z.string().optional() }),
          parseInput: (input) => (input.value === null ? {} : { value: input.value }),
          execute: async (input) => z.json().parse(input),
          describeTarget: () => null,
        }),
      ],
      release: async () => {},
    };
    const contract = createEffectOutputContract(createEffectRegistry([provider]));

    expect(
      contract.parse(
        JSON.stringify({
          effects: [{ type: "fake.normalize", input: { value: null } }],
        }),
      ),
    ).toEqual({ effects: [{ type: "fake.normalize", input: {} }] });
  });

  it("malformed JSONを拒否する", () => {
    const contract = createEffectOutputContract(createEffectRegistry([createProvider()]));

    expect(() => contract.parse("{")).toThrow("Effect output is not valid JSON.");
  });

  it("未登録typeを拒否する", () => {
    const contract = createEffectOutputContract(createEffectRegistry([createProvider()]));

    expect(() =>
      contract.parse(
        JSON.stringify({
          effects: [{ type: "fake.unknown", input: { target: "audit", value: "first" } }],
        }),
      ),
    ).toThrow("Invalid effect fake.unknown: Unknown effect type: fake.unknown");
  });

  it.each([
    { effects: [{ input: { target: "audit", value: "first" } }] },
    { effects: [{ type: "fake.record" }] },
  ])("typeまたはinputが欠けたEffectを拒否する", (output) => {
    const contract = createEffectOutputContract(createEffectRegistry([createProvider()]));

    expect(() => contract.parse(JSON.stringify(output))).toThrow();
  });

  it("余分なpropertyを拒否する", () => {
    const contract = createEffectOutputContract(createEffectRegistry([createProvider()]));

    expect(() =>
      contract.parse(
        JSON.stringify({
          effects: [
            {
              type: "fake.record",
              input: { target: "audit", value: "first" },
              extra: true,
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("definitionのinput schemaに反する入力を拒否する", () => {
    const contract = createEffectOutputContract(createEffectRegistry([createProvider()]));

    expect(() =>
      contract.parse(
        JSON.stringify({
          effects: [{ type: "fake.record", input: { target: 123, value: "first" } }],
        }),
      ),
    ).toThrow("Invalid effect fake.record:");
  });

  it("Codexが受理しないJSON Schema keywordを拒否する", () => {
    const provider: EffectProvider = {
      definitions: [
        defineEffect({
          type: "fake.invalid_transport",
          agentInputSchema: z.strictObject({ value: z.string().min(1) }),
          inputSchema: z.strictObject({ value: z.string().min(1) }),
          parseInput: (input) => input,
          execute: async (input) => input,
          describeTarget: () => null,
        }),
      ],
      release: async () => {},
    };

    expect(() => createEffectOutputContract(createEffectRegistry([provider]))).toThrow(
      "unsupported JSON Schema keyword: minLength",
    );
  });

  it("埋め込み先で参照先が変わるlocal JSON Schema参照を拒否する", () => {
    const recursiveSchema: z.ZodType<JsonValue> = z.lazy(() => z.array(recursiveSchema));
    const provider: EffectProvider = {
      definitions: [
        defineEffect({
          type: "fake.recursive",
          agentInputSchema: recursiveSchema,
          inputSchema: recursiveSchema,
          parseInput: (input) => input,
          execute: async (input) => input,
          describeTarget: () => null,
        }),
      ],
      release: async () => undefined,
    };

    expect(() => createEffectOutputContract(createEffectRegistry([provider]))).toThrow(
      /unsupported JSON Schema keyword: \$ref/,
    );
  });
});

describe("createEffectRegistry", () => {
  it("Effect Typeの重複を拒否する", () => {
    expect(() => createEffectRegistry([createProvider(), createProvider()])).toThrow(
      "Duplicate effect type registration: fake.record",
    );
  });

  it("definitionが0件のregistryを拒否する", () => {
    expect(() => createEffectRegistry([])).toThrow(
      "Effect registry requires at least one definition.",
    );
  });
});

function validateStructuredOutputSchema(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) validateStructuredOutputSchema(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  for (const keyword of Object.keys(value)) {
    expect(SUPPORTED_SCHEMA_KEYWORDS).toContain(keyword);
  }

  if ("type" in value && value.type === "object") {
    expect(value).toHaveProperty("additionalProperties", false);
    if ("properties" in value && isRecord(value.properties)) {
      expect(value).toHaveProperty("required", Object.keys(value.properties));
    }
  }

  if ("properties" in value && isRecord(value.properties)) {
    for (const propertySchema of Object.values(value.properties)) {
      validateStructuredOutputSchema(propertySchema);
    }
  }
  if ("items" in value) validateStructuredOutputSchema(value.items);
  if ("anyOf" in value) validateStructuredOutputSchema(value.anyOf);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
