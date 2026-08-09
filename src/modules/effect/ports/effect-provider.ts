import type { z } from "zod";

import { jsonValueSchema, type JsonValue } from "../../event/domain/luna-event";

export interface EffectDefinition {
  readonly type: string;
  readonly agentInputSchema: z.ZodType;
  parseInput(value: JsonValue): JsonValue;
  execute(input: JsonValue, ownerId: string): Promise<JsonValue>;
  describeTarget(input: JsonValue): JsonValue;
}

export interface EffectProvider {
  readonly definitions: readonly EffectDefinition[];
  release(ownerId: string): Promise<void>;
}

export type EffectDefinitionConfig<AgentInput extends JsonValue, Input> = Readonly<{
  type: string;
  agentInputSchema: z.ZodType<AgentInput>;
  inputSchema: z.ZodType<Input>;
  parseInput(input: AgentInput): Input;
  execute(input: Input, ownerId: string): Promise<JsonValue>;
  describeTarget(input: Input): JsonValue;
}>;

export function defineEffect<AgentInput extends JsonValue, Input>(
  config: EffectDefinitionConfig<AgentInput, Input>,
): EffectDefinition {
  const parseAgentInput = (value: JsonValue): AgentInput => config.agentInputSchema.parse(value);
  const parseExecutionInput = (value: JsonValue): Input => config.inputSchema.parse(value);

  return Object.freeze({
    type: config.type,
    agentInputSchema: config.agentInputSchema,
    parseInput: (value: JsonValue): JsonValue =>
      jsonValueSchema.parse(config.parseInput(parseAgentInput(value))),
    execute: async (value: JsonValue, ownerId: string): Promise<JsonValue> =>
      jsonValueSchema.parse(await config.execute(parseExecutionInput(value), ownerId)),
    describeTarget: (value: JsonValue): JsonValue =>
      jsonValueSchema.parse(config.describeTarget(parseExecutionInput(value))),
  });
}
