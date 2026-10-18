import type { z } from "zod";

import type { JsonValue } from "../../../shared/json";
import type { EffectExecution, EffectRequest } from "../domain/effect";

export interface EffectDefinition {
	readonly type: string;
	readonly agentInputSchema: z.ZodType;
	parse(value: JsonValue): EffectRequest;
}

export interface EffectProvider {
	readonly definitions: readonly EffectDefinition[];
	release(ownerId: string): Promise<void>;
}

export function defineEffect<AgentInput extends JsonValue, Input>(
	config: Readonly<{
		type: string;
		agentInputSchema: z.ZodType<AgentInput>;
		parseInput(input: AgentInput): Input;
		execute(input: NoInfer<Input>, execution: EffectExecution): Promise<JsonValue>;
		describeTarget(input: NoInfer<Input>): JsonValue;
	}>,
): EffectDefinition {
	return Object.freeze({
		type: config.type,
		agentInputSchema: config.agentInputSchema,
		parse: (value: JsonValue): EffectRequest => {
			const input = config.parseInput(config.agentInputSchema.parse(value));
			return {
				type: config.type,
				input: value,
				target: config.describeTarget(input),
				run: async (execution) => await config.execute(input, execution),
			};
		},
	});
}
