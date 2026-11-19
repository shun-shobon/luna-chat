import { randomUUID } from "node:crypto";

import type { Api, Model, Models } from "@earendil-works/pi-ai";

import type {
	ModelStream,
	ModelStreamEvent,
	ModelStreamPort,
	ModelStreamSpec,
} from "../../../ports/outbound/model-stream-port";
import { keepSpareClaudeProcess } from "./claude-code/claude-cli";
import { PROVIDER_ID as CLAUDE_CODE_PROVIDER_ID } from "./claude-code/model-catalog";
import { resolveModel } from "./pi-agent-session";

export class PiModelStreams implements ModelStreamPort {
	constructor(private readonly options: Readonly<{ models: Models; requestTimeoutMs: number }>) {}

	open(spec: ModelStreamSpec): ModelStream {
		const model = resolveModel(this.options.models, spec.model);
		const sessionId = randomUUID();
		// 毎回の要求が前の続きにならないため、Claude Code では起動待ちを隠す予備のプロセスを控える。
		const releaseSpare =
			model.provider === CLAUDE_CODE_PROVIDER_ID ? keepSpareClaudeProcess(sessionId) : undefined;
		return {
			stream: (prompt, signal) => this.#stream(model, spec, sessionId, prompt, signal),
			close: async () => {
				await releaseSpare?.();
			},
		};
	}

	async *#stream(
		model: Model<Api>,
		spec: ModelStreamSpec,
		sessionId: string,
		prompt: string,
		signal: AbortSignal,
	): AsyncIterable<ModelStreamEvent> {
		const events = this.options.models.streamSimple(
			model,
			{
				systemPrompt: spec.systemPrompt,
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
				tools: spec.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			},
			{
				signal,
				sessionId,
				timeoutMs: this.options.requestTimeoutMs,
				// 返事は待てないので、失敗したら呼び出し側で打ち切る。
				maxRetries: 0,
				...(spec.model.thinking === "off" ? {} : { reasoning: spec.model.thinking }),
			},
		);
		for await (const event of events) {
			if (event.type === "text_delta") {
				yield { type: "text", delta: event.delta };
			} else if (event.type === "toolcall_end") {
				yield { type: "tool_call", name: event.toolCall.name, arguments: event.toolCall.arguments };
			} else if (event.type === "error") {
				signal.throwIfAborted();
				throw new Error(event.error.errorMessage ?? `model stream ended with ${event.reason}`);
			}
		}
	}
}
