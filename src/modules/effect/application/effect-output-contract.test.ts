import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { JsonValue } from "../../event/domain/luna-event";
import type { EffectProvider } from "../ports/effect-provider";
import { defineEffect } from "../ports/effect-provider";
import { createEffectOutputContract } from "./effect-output-contract";
import { createEffectRegistry } from "./effect-registry";

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
				parseInput: (input) => input,
				execute,
				describeTarget: (input) => input.target,
			}),
		],
		release: async () => {},
	};
}

describe("createEffectOutputContract", () => {
	it("登録済みdefinitionごとにtypeを固定したschemaを作る", () => {
		const contract = createEffectOutputContract(
			createEffectRegistry([createProvider(), createProvider("fake.notify")]),
		);

		expect(contract.jsonSchema).toMatchObject({
			properties: {
				effects: {
					items: {
						anyOf: [
							{ properties: { type: { const: "fake.record" } } },
							{ properties: { type: { const: "fake.notify" } } },
						],
					},
				},
			},
		});
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
		).toMatchObject({
			effects: [
				{ type: "fake.record", input: { target: "audit", value: "first" }, target: "audit" },
			],
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

	it("Agent入力を実行用inputへ正規化する", async () => {
		const provider: EffectProvider = {
			definitions: [
				defineEffect({
					type: "fake.normalize",
					agentInputSchema: z.strictObject({ value: z.string().nullable() }),
					parseInput: (input) => (input.value == null ? {} : { value: input.value }),
					execute: async (input) => z.json().parse(input),
					describeTarget: () => null,
				}),
			],
			release: async () => {},
		};
		const contract = createEffectOutputContract(createEffectRegistry([provider]));

		const [effect] = contract.parse(
			JSON.stringify({
				effects: [{ type: "fake.normalize", input: { value: null } }],
			}),
		).effects;

		await expect(effect?.run("owner-1")).resolves.toEqual({});
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
		{
			output: { effects: [{ input: { target: "audit", value: "first" } }] },
			message: "at effects[0].type",
		},
		{ output: { effects: [{ type: "fake.record" }] }, message: "at effects[0].input" },
	])("typeまたはinputが欠けたEffectを拒否する", ({ output, message }) => {
		const contract = createEffectOutputContract(createEffectRegistry([createProvider()]));

		expect(() => contract.parse(JSON.stringify(output))).toThrow(message);
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
		).toThrow('Unrecognized key: "extra"');
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
});
