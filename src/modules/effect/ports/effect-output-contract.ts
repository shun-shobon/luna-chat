import type { JsonObject } from "../../../shared/json";
import type { EffectOutput } from "../domain/effect";

export interface EffectOutputContract {
	readonly jsonSchema: JsonObject;
	parse(text: string): EffectOutput;
}
