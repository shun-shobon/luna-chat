import type { JsonValue } from "../../../shared/json";

export type EffectOrigin =
	| Readonly<{
			kind: "conversation";
			session: Readonly<{ key: string; source: string; context: JsonValue }>;
	  }>
	| Readonly<{ kind: "event"; eventId: string; eventType: string }>
	| Readonly<{ kind: "task"; taskId: string }>;

export type EffectExecution = Readonly<{ ownerId: string; origin: EffectOrigin }>;

export type EffectRequest = Readonly<{
	type: string;
	input: JsonValue;
	target: JsonValue;
	run(execution: EffectExecution): Promise<JsonValue>;
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

export const WAIT_EFFECT_TYPE = "system.wait";

export function requiresEffectFollowUp(results: readonly EffectResult[]): boolean {
	return results.some((result) => !result.success || result.type === WAIT_EFFECT_TYPE);
}
