import { isDeepStrictEqual } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { createEffectOutputContract } from "../modules/effect/application/effect-output-contract";
import { createEffectRegistry } from "../modules/effect/application/effect-registry";
import { HttpResponseRegistry } from "../modules/http/application/http-response-registry";
import { createEffectProviders } from "./effect-providers";

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

const providers = createEffectProviders({
	actions: { execute: vi.fn(), releaseTyping: vi.fn() },
	delegation: { delegate: vi.fn() },
	httpResponses: new HttpResponseRegistry(),
});

describe("Effect providers", () => {
	it("Effect typeが重複しない", () => {
		const types = providers.flatMap((provider) => provider.definitions.map(({ type }) => type));

		expect(new Set(types).size).toBe(types.length);
	});

	it("出力schemaがCodex Structured Outputsで受理されるsubsetに収まる", () => {
		const contract = createEffectOutputContract(createEffectRegistry(providers));

		expect(collectStructuredOutputSchemaViolations(contract.jsonSchema)).toEqual([]);
	});
});

function collectStructuredOutputSchemaViolations(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item) => collectStructuredOutputSchemaViolations(item));
	}
	if (typeof value !== "object" || value == null) return [];

	const violations = Object.keys(value)
		.filter((keyword) => !SUPPORTED_SCHEMA_KEYWORDS.has(keyword))
		.map((keyword) => `unsupported keyword: ${keyword}`);

	if ("type" in value && value.type === "object") {
		if (!("additionalProperties" in value) || value.additionalProperties !== false) {
			violations.push("object schema must set additionalProperties: false");
		}
		if (
			"properties" in value &&
			isRecord(value.properties) &&
			!("required" in value && isDeepStrictEqual(value.required, Object.keys(value.properties)))
		) {
			violations.push("object schema must require every property");
		}
	}

	if ("properties" in value && isRecord(value.properties)) {
		for (const propertySchema of Object.values(value.properties)) {
			violations.push(...collectStructuredOutputSchemaViolations(propertySchema));
		}
	}
	if ("items" in value) violations.push(...collectStructuredOutputSchemaViolations(value.items));
	if ("anyOf" in value) violations.push(...collectStructuredOutputSchemaViolations(value.anyOf));
	return violations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null && !Array.isArray(value);
}
