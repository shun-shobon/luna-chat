import type { EffectOutput } from "../domain/effect";

export interface EffectOutputContract {
  readonly jsonSchema: Record<string, unknown>;
  parse(text: string): EffectOutput;
}
