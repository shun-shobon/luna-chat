import { z } from "zod";

import { agentOutputSchema, type AgentOutput } from "../../discord/domain/discord-action";

export const AGENT_OUTPUT_JSON_SCHEMA = z.toJSONSchema(agentOutputSchema);

class AgentOutputParseError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentOutputParseError";
  }
}

function parseAgentOutput(value: unknown): AgentOutput {
  const result = agentOutputSchema.safeParse(value);
  if (!result.success) {
    throw new AgentOutputParseError(z.prettifyError(result.error));
  }
  return result.data;
}

export function parseAgentOutputText(text: string): AgentOutput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    throw new AgentOutputParseError("Agent output is not valid JSON.", { cause: error });
  }
  return parseAgentOutput(value);
}
