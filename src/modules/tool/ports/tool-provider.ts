import type { z } from "zod";

import type { JsonValue } from "../../../shared/json";
import type { ToolExecution, ToolInvocation } from "../domain/tool";

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: z.ZodType;
	invoke(value: unknown, execution: ToolExecution): Promise<ToolInvocation>;
}

export interface ToolProvider {
	readonly definitions: readonly ToolDefinition[];
	release(ownerId: string): Promise<void>;
}

export function defineTool<AgentInput, Input>(
	config: Readonly<{
		name: string;
		description: string;
		inputSchema: z.ZodType<AgentInput>;
		parseInput(input: AgentInput): Input;
		execute(input: NoInfer<Input>, execution: ToolExecution): Promise<unknown>;
		describeTarget(input: NoInfer<Input>): JsonValue;
	}>,
): ToolDefinition {
	return Object.freeze({
		name: config.name,
		description: config.description,
		inputSchema: config.inputSchema,
		invoke: async (value: unknown, execution: ToolExecution): Promise<ToolInvocation> => {
			const input = config.parseInput(config.inputSchema.parse(value));
			const target = config.describeTarget(input);
			return { target, value: await config.execute(input, execution) };
		},
	});
}
