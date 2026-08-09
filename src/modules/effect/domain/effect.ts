import type { JsonValue } from "../../event/domain/luna-event";

export type EffectRequest = Readonly<{
  type: string;
  input: JsonValue;
}>;

export type EffectOutput = Readonly<{
  effects: readonly EffectRequest[];
}>;

export type EffectResult = Readonly<{
  index: number;
  type: string;
  target: JsonValue;
}> &
  (Readonly<{ success: true; value: JsonValue }> | Readonly<{ success: false; error: string }>);
