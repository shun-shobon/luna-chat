import {
	calculateCost,
	collapseSystemMessages,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	getInitialSystemMessage,
	getSystemMessageText,
} from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	JsonObject,
	Model,
	SimpleStreamOptions,
	StopReason,
	TranscriptContext,
} from "@earendil-works/pi-ai";

import { describeUsageCreditsRejection } from "./billing";
import { runClaudeRequest } from "./claude-cli";
import { supportsNativeToolChanges } from "./model-catalog";
import { jsonObjectSchema, toJsonObject } from "./native-types";
import type {
	AnthropicStreamEvent,
	NativeContentBlock,
	NativeMessage,
	NativeUsage,
	PartialNativeUsage,
} from "./native-types";
import {
	buildExtraBody,
	getInitialSystemMessages,
	makeReplayDiagnostic,
	NATIVE_TOOL_CHANGES_BETA,
	prepareFrames,
	prepareMessages,
	prepareNativeTranscript,
	prepareTools,
	TOOL_PREFIX,
} from "./transcript";

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function mapStopReason(reason: string | null | undefined): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	switch (reason) {
		case "end_turn":
		case "pause_turn":
		case "stop_sequence": {
			return { stopReason: "stop" };
		}
		case "max_tokens":
		case "model_context_window_exceeded": {
			return { stopReason: "length" };
		}
		case "tool_use": {
			return { stopReason: "toolUse" };
		}
		case "refusal": {
			return { stopReason: "error", errorMessage: "The model refused to complete the request" };
		}
		case "sensitive": {
			return { stopReason: "error", errorMessage: "Provider stopped with: sensitive" };
		}
		default: {
			return {
				stopReason: "error",
				errorMessage: `Unhandled Claude Code stop reason: ${reason ?? "missing"}`,
			};
		}
	}
}

function parseArguments(raw: string, fallback: JsonObject): JsonObject {
	if (raw.trim() === "") return fallback;
	try {
		const parsed = jsonObjectSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : fallback;
	} catch {
		return fallback;
	}
}

function updateUsage(
	output: AssistantMessage,
	model: Model<Api>,
	usage: NativeUsage | PartialNativeUsage | null | undefined,
): void {
	if (!usage) return;
	if (typeof usage.input_tokens === "number") output.usage.input = usage.input_tokens;
	if (typeof usage.output_tokens === "number") output.usage.output = usage.output_tokens;
	if (typeof usage.cache_read_input_tokens === "number") {
		output.usage.cacheRead = usage.cache_read_input_tokens;
	}
	if (typeof usage.cache_creation_input_tokens === "number") {
		output.usage.cacheWrite = usage.cache_creation_input_tokens;
	}
	const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens;
	if (typeof oneHour === "number") output.usage.cacheWrite1h = oneHour;
	const thinking = usage.output_tokens_details?.thinking_tokens;
	if (typeof thinking === "number") output.usage.reasoning = thinking;
	output.usage.totalTokens =
		output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
}

function comparableContent(content: AssistantMessage["content"]): unknown[] {
	return content.map((block) => {
		if (block.type === "text") return { type: "text", text: block.text };
		if (block.type === "thinking") {
			return {
				type: "thinking",
				thinking: block.thinking,
				thinkingSignature: block.thinkingSignature,
				redacted: block.redacted,
			};
		}
		return { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
	});
}

// 宣言していないツール名でも、エージェントのループが「見つからない」と返せばモデルは立て直せる。失敗にせずそのまま渡す。
function piToolName(nativeName: string): string {
	return nativeName.startsWith(TOOL_PREFIX) ? nativeName.slice(TOOL_PREFIX.length) : nativeName;
}

function nativeContent(content: NativeContentBlock[]): AssistantMessage["content"] {
	const converted: AssistantMessage["content"] = [];
	for (const block of content) {
		switch (block.type) {
			case "text": {
				converted.push({ type: "text", text: block.text });
				break;
			}
			case "thinking": {
				converted.push({
					type: "thinking",
					thinking: block.thinking,
					...(block.signature === undefined ? {} : { thinkingSignature: block.signature }),
				});
				break;
			}
			case "redacted_thinking": {
				converted.push({
					type: "thinking",
					thinking: "[Reasoning redacted]",
					thinkingSignature: block.data,
					redacted: true,
				});
				break;
			}
			case "tool_use": {
				converted.push({
					type: "toolCall",
					id: block.id,
					name: piToolName(block.name),
					arguments: toJsonObject(block.input),
				});
				break;
			}
		}
	}
	return converted;
}

class EventTranslator {
	private readonly nativeToContent = new Map<number, number>();
	private readonly partialJsonByContent = new Map<number, string>();
	private sawContentEvent = false;

	constructor(
		private readonly model: Model<Api>,
		private readonly output: AssistantMessage,
		private readonly stream: AssistantMessageEventStream,
	) {}

	event(event: AnthropicStreamEvent): void {
		switch (event.type) {
			case "message_start": {
				if (event.message.id !== undefined && event.message.id !== "") {
					this.output.responseId = event.message.id;
				}
				updateUsage(this.output, this.model, event.message.usage);
				break;
			}
			case "content_block_start": {
				this.startBlock(event.index, event.content_block);
				break;
			}
			case "content_block_delta": {
				this.delta(event.index, event.delta);
				break;
			}
			case "content_block_stop": {
				this.stopBlock(event.index);
				break;
			}
			case "message_delta": {
				const stopReason = event.delta.stop_reason;
				if (stopReason != null && stopReason !== "") {
					this.output.rawStopReason = stopReason;
					const mapped = mapStopReason(stopReason);
					this.output.stopReason = mapped.stopReason;
					this.output.errorMessage = mapped.errorMessage;
				}
				updateUsage(this.output, this.model, event.usage);
				break;
			}
			case "message_stop":
			case "error": {
				break;
			}
		}
	}

	finish(message: NativeMessage, usage: NativeUsage, initialSystemMessages?: unknown[]): void {
		const authoritative = nativeContent(message.content);
		if (!this.sawContentEvent) {
			this.emitComplete(authoritative);
		} else if (
			JSON.stringify(comparableContent(this.output.content)) !==
			JSON.stringify(comparableContent(authoritative))
		) {
			throw new Error("Claude Code final response differs from its incremental stream");
		}

		if (message.id !== undefined && message.id !== "") this.output.responseId = message.id;
		updateUsage(this.output, this.model, usage);
		this.output.rawStopReason = message.stop_reason ?? undefined;
		const mapped = mapStopReason(message.stop_reason);
		this.output.stopReason = mapped.stopReason;
		this.output.errorMessage = mapped.errorMessage;
		this.output.diagnostics = [
			...(this.output.diagnostics ?? []),
			makeReplayDiagnostic(message, this.output, initialSystemMessages),
		];
	}

	private startBlock(nativeIndex: number, native: NativeContentBlock): void {
		this.sawContentEvent = true;
		const contentIndex = this.output.content.length;
		this.nativeToContent.set(nativeIndex, contentIndex);
		switch (native.type) {
			case "text": {
				this.output.content.push({ type: "text", text: native.text });
				this.stream.push({ type: "text_start", contentIndex, partial: this.output });
				break;
			}
			case "thinking": {
				this.output.content.push({
					type: "thinking",
					thinking: native.thinking,
					thinkingSignature: native.signature ?? "",
				});
				this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
				break;
			}
			case "redacted_thinking": {
				this.output.content.push({
					type: "thinking",
					thinking: "[Reasoning redacted]",
					thinkingSignature: native.data,
					redacted: true,
				});
				this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
				break;
			}
			case "tool_use": {
				this.output.content.push({
					type: "toolCall",
					id: native.id,
					name: piToolName(native.name),
					arguments: toJsonObject(native.input),
				});
				this.partialJsonByContent.set(contentIndex, "");
				this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
				break;
			}
		}
	}

	private delta(
		nativeIndex: number,
		delta: Extract<AnthropicStreamEvent, { type: "content_block_delta" }>["delta"],
	): void {
		const contentIndex = this.nativeToContent.get(nativeIndex);
		if (contentIndex === undefined) return;
		const block = this.output.content[contentIndex];
		if (!block) return;

		if (delta.type === "text_delta" && block.type === "text") {
			block.text += delta.text;
			this.stream.push({
				type: "text_delta",
				contentIndex,
				delta: delta.text,
				partial: this.output,
			});
		} else if (delta.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += delta.thinking;
			this.stream.push({
				type: "thinking_delta",
				contentIndex,
				delta: delta.thinking,
				partial: this.output,
			});
		} else if (delta.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
		} else if (delta.type === "input_json_delta" && block.type === "toolCall") {
			const partialJson = (this.partialJsonByContent.get(contentIndex) ?? "") + delta.partial_json;
			this.partialJsonByContent.set(contentIndex, partialJson);
			block.arguments = parseArguments(partialJson, block.arguments);
			this.stream.push({
				type: "toolcall_delta",
				contentIndex,
				delta: delta.partial_json,
				partial: this.output,
			});
		}
	}

	private stopBlock(nativeIndex: number): void {
		const contentIndex = this.nativeToContent.get(nativeIndex);
		if (contentIndex === undefined) return;
		const block = this.output.content[contentIndex];
		if (!block) return;
		switch (block.type) {
			case "text": {
				this.stream.push({
					type: "text_end",
					contentIndex,
					content: block.text,
					partial: this.output,
				});
				break;
			}
			case "thinking": {
				this.stream.push({
					type: "thinking_end",
					contentIndex,
					content: block.thinking,
					partial: this.output,
				});
				break;
			}
			case "toolCall": {
				block.arguments = parseArguments(
					this.partialJsonByContent.get(contentIndex) ?? "",
					block.arguments,
				);
				this.partialJsonByContent.delete(contentIndex);
				this.stream.push({
					type: "toolcall_end",
					contentIndex,
					toolCall: block,
					partial: this.output,
				});
				break;
			}
		}
	}

	private emitComplete(content: AssistantMessage["content"]): void {
		for (const source of content) {
			const contentIndex = this.output.content.length;
			switch (source.type) {
				case "text": {
					this.output.content.push({ ...source });
					this.stream.push({ type: "text_start", contentIndex, partial: this.output });
					if (source.text !== "") {
						this.stream.push({
							type: "text_delta",
							contentIndex,
							delta: source.text,
							partial: this.output,
						});
					}
					this.stream.push({
						type: "text_end",
						contentIndex,
						content: source.text,
						partial: this.output,
					});
					break;
				}
				case "thinking": {
					this.output.content.push({ ...source });
					this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
					if (source.thinking !== "" && source.redacted !== true) {
						this.stream.push({
							type: "thinking_delta",
							contentIndex,
							delta: source.thinking,
							partial: this.output,
						});
					}
					this.stream.push({
						type: "thinking_end",
						contentIndex,
						content: source.thinking,
						partial: this.output,
					});
					break;
				}
				case "toolCall": {
					this.output.content.push({ ...source });
					this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
					this.stream.push({
						type: "toolcall_delta",
						contentIndex,
						delta: JSON.stringify(source.arguments),
						partial: this.output,
					});
					this.stream.push({
						type: "toolcall_end",
						contentIndex,
						toolCall: source,
						partial: this.output,
					});
					break;
				}
			}
		}
	}
}

const CONTEXT_LENGTH_MESSAGE =
	/prompt is too long|context(?:_| )length|context window exceeded|too many input tokens/iu;

export function normalizeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const usageCredits = describeUsageCreditsRejection(message);
	if (usageCredits !== undefined) return usageCredits;
	if (CONTEXT_LENGTH_MESSAGE.test(message)) return `context_length_exceeded: ${message}`;
	return message;
}

export function streamClaudeCode(
	model: Model<Api>,
	sourceContext: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};

	void (async () => {
		try {
			const context = {
				...sourceContext,
				messages: prepareMessages(sourceContext.messages, model),
			};
			const nativeTranscript = prepareNativeTranscript(
				context.messages,
				supportsNativeToolChanges(model.id),
			);
			const transcript = nativeTranscript ? context : collapseSystemMessages(context);
			const initialSystem = getInitialSystemMessage(transcript.messages);
			const systemPrompt = nativeTranscript
				? initialSystem
					? getSystemMessageText(initialSystem)
					: ""
				: getCurrentSystemPrompt(transcript.messages);
			const tools = getCurrentTools(transcript.messages);
			const frames = prepareFrames(transcript.messages);
			const initialSystemMessages = getInitialSystemMessages(transcript.messages);
			const preparedTools = prepareTools(tools);
			const extraBody = buildExtraBody(
				model.id,
				nativeTranscript?.requestTools ?? preparedTools.nativeTools,
				options,
			);
			const translator = new EventTranslator(model, output, stream);

			stream.push({ type: "start", partial: output });
			const response = await runClaudeRequest({
				model: model.id,
				cwd: process.cwd(),
				frames,
				systemPrompt,
				manifest: preparedTools.manifest,
				extraBody,
				signal: options?.signal,
				timeoutMs: options?.timeoutMs,
				env: options?.env,
				initialSystemMessages,
				nativeSystemInjections: nativeTranscript?.systemInjections,
				betas: nativeTranscript ? [NATIVE_TOOL_CHANGES_BETA] : undefined,
				sessionId: options?.cacheRetention === "none" ? undefined : options?.sessionId,
				onEvent: (event) => {
					translator.event(event);
				},
			});
			translator.finish(response.message, response.usage, response.initialSystemMessages);
			output.providerThinkingLevel = options?.reasoning;
			output.diagnostics = [
				...(output.diagnostics ?? []),
				{
					type: "claude-code.turn-relay",
					timestamp: Date.now(),
					details: toJsonObject(response.relay),
				},
				...(response.rateLimit
					? [
							{
								type: "claude-code.rate-limit",
								timestamp: Date.now(),
								details: toJsonObject(response.rateLimit),
							},
						]
					: []),
			];

			const stopReason: StopReason = output.stopReason;
			if (stopReason === "error" || stopReason === "aborted" || stopReason === "pending") {
				throw new Error(
					output.errorMessage !== undefined && output.errorMessage !== ""
						? output.errorMessage
						: `Claude Code ended with ${stopReason}`,
				);
			}
			stream.push({ type: "done", reason: stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted === true ? "aborted" : "error";
			output.errorMessage = normalizeError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}
