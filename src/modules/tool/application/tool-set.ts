import { z } from "zod";

import { jsonObjectSchema } from "../../../shared/json";
import type { JsonObject } from "../../../shared/json";
import type { AgentTool, AgentToolResult } from "../../agent/ports/outbound/agent-session-port";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type { ToolExecution } from "../domain/tool";
import type { ToolDefinition, ToolProvider } from "../ports/tool-provider";

export interface ToolSet {
	readonly definitions: readonly ToolDefinition[];
	bind(execution: Omit<ToolExecution, "signal">): readonly AgentTool[];
	release(ownerId: string): Promise<void>;
}

export function createToolSet(providers: readonly ToolProvider[], logger: LoggerPort): ToolSet {
	const definitions = providers.flatMap((provider) => provider.definitions);
	const names = new Set<string>();
	for (const definition of definitions) {
		if (names.has(definition.name)) throw new Error(`Duplicate tool name: ${definition.name}`);
		names.add(definition.name);
	}
	const parameters = new Map(
		definitions.map((definition) => [definition.name, toParameters(definition)]),
	);

	return Object.freeze({
		definitions,
		bind: (execution: Omit<ToolExecution, "signal">): readonly AgentTool[] =>
			definitions.map((definition) => ({
				name: definition.name,
				description: definition.description,
				parameters: parameters.get(definition.name) ?? toParameters(definition),
				execute: async (value: unknown, signal: AbortSignal): Promise<AgentToolResult> =>
					await invoke(definition, value, { ...execution, signal }, logger),
			})),
		release: async (ownerId: string): Promise<void> => {
			const settled = await Promise.allSettled(
				providers.map(async (provider) => await provider.release(ownerId)),
			);
			settled.forEach((result, providerIndex) => {
				if (result.status === "fulfilled") return;
				logger.log(
					"warn",
					"tool.provider_release_failed",
					{},
					{ error: result.reason, ownerId, providerIndex },
				);
			});
		},
	});
}

async function invoke(
	definition: ToolDefinition,
	value: unknown,
	execution: ToolExecution,
	logger: LoggerPort,
): Promise<AgentToolResult> {
	try {
		const invocation = await definition.invoke(value, execution);
		logger.log(
			"info",
			"tool.succeeded",
			{},
			{ ownerId: execution.ownerId, target: invocation.target, toolName: definition.name },
			{ input: value, result: invocation.value },
		);
		return { text: JSON.stringify(invocation.value), images: [], isError: false };
	} catch (error: unknown) {
		const message = error instanceof z.ZodError ? z.prettifyError(error) : errorMessage(error);
		logger.log(
			"warn",
			"tool.failed",
			{},
			{ error: message, ownerId: execution.ownerId, toolName: definition.name },
			{ input: value },
		);
		return { text: message, images: [], isError: true };
	}
}

function toParameters(definition: ToolDefinition): JsonObject {
	const schema: Record<string, unknown> = { ...z.toJSONSchema(definition.inputSchema) };
	delete schema["$schema"];
	// z.toJSONSchema の型は unknown を含むため、一度だけ検証して型付きのJSONオブジェクトにする。
	return jsonObjectSchema.parse(schema);
}

function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}
