import { z } from "zod";

import type { JsonObject } from "../../../shared/json";
import type { ModelStream } from "../../agent/ports/outbound/model-stream-port";
import type { LoggerPort } from "../../observability/ports/logger-port";
import { formatRecordLine } from "../domain/voice-record";
import type { VoiceRecordEntry } from "../domain/voice-record";

export const DELEGATE_TOOL: Readonly<{
	name: string;
	description: string;
	parameters: JsonObject;
}> = {
	name: "delegate",
	description:
		"Ask your backstage self, the whole Luna with tools, to look something up or do something. It works in the background and its report appears later in the voice record.",
	parameters: {
		type: "object",
		properties: {
			request: {
				type: "string",
				description: "What to find out or do, written so that it makes sense on its own.",
			},
		},
		required: ["request"],
		additionalProperties: false,
	},
};

const DelegateInputSchema = z.object({ request: z.string().trim().min(1) });

export type ResponderEvent =
	| Readonly<{ type: "text"; delta: string }>
	| Readonly<{ type: "delegate"; request: string }>;

// 表に何をきっかけに話させるか。
export type ResponderTrigger =
	| Readonly<{ kind: "turn"; speaker: string }>
	| Readonly<{ kind: "report" }>;

// 表のモデルに会話記録を渡し、返事の文字と裏への依頼を流す。
export class VoiceResponder {
	constructor(
		private readonly stream: ModelStream,
		private readonly logger: LoggerPort,
	) {}

	async *respond(
		input: Readonly<{ record: readonly VoiceRecordEntry[]; trigger: ResponderTrigger }>,
		signal: AbortSignal,
	): AsyncIterable<ResponderEvent> {
		for await (const event of this.stream.stream(
			buildPrompt(input.record, input.trigger),
			signal,
		)) {
			if (event.type === "text") {
				yield event;
				continue;
			}
			const parsed = DelegateInputSchema.safeParse(event.arguments);
			if (event.name !== DELEGATE_TOOL.name || !parsed.success) {
				this.logger.warn("voice.front.invalid_tool_call", { name: event.name });
				continue;
			}
			yield { type: "delegate", request: parsed.data.request };
		}
	}

	async close(): Promise<void> {
		await this.stream.close();
	}
}

function buildPrompt(record: readonly VoiceRecordEntry[], trigger: ResponderTrigger): string {
	const lines = record.map(formatRecordLine).join("\n");
	const now =
		trigger.kind === "turn"
			? `${trigger.speaker} just finished speaking. Write what Luna says now, or nothing.`
			: "A new backstage report arrived and nobody is talking. Write what Luna tells people now, or nothing.";
	return `<voice_record>\n${lines}\n</voice_record>\n\n${now}`;
}
