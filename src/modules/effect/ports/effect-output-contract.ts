import type { JsonObject } from "../../../shared/json";
import type { EffectOutput } from "../domain/effect";

export interface EffectOutputContract {
	readonly jsonSchema: JsonObject;
	parse(text: string): EffectOutput;
}

export function parseEffectOutputs(
	contract: EffectOutputContract,
	texts: readonly string[],
): EffectOutput {
	return { effects: texts.flatMap((text) => contract.parse(text).effects) };
}
