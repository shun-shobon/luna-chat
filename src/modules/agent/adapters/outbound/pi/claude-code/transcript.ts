import {
	getDeclaredTools,
	getInitialSystemMessage,
	hasToolRedefinitions,
	renderSystemMessageUpdate,
} from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	JsonObject,
	Message,
	Model,
	SimpleStreamOptions,
	SystemMessage,
	TextContent,
	Tool,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { z } from "zod";

import { supportsAdaptiveThinking, supportsDisabledThinking } from "./model-catalog";
import { isRecord, jsonObjectSchema, nativeMessageSchema, toJsonObject } from "./native-types";
import type { NativeContentBlock, NativeFrame, NativeMessage } from "./native-types";

export const TOOL_PREFIX = "mcp__pi__";
const NATIVE_REPLAY_DIAGNOSTIC = "claude-code.native-assistant.v1";
export const NATIVE_TOOL_CHANGES_BETA = "mid-conversation-tool-changes-2026-07-01";

const DEFERRED_TOOL_PLACEHOLDER = {
	name: "__pi_deferred_placeholder__",
	description: "Reserved placeholder. Never available. Never call this.",
	input_schema: { type: "object", properties: {}, required: [] },
	defer_loading: true,
};

export type NativeSystemInjection = {
	// この0始まりの assistant の直前に入れる。null は末尾。
	beforeAssistant: number | null;
	content: Record<string, unknown>[];
};

type AssistantMessageDiagnostic = NonNullable<AssistantMessage["diagnostics"]>[number];

type NativeTranscriptPlan = {
	requestTools: Record<string, unknown>[];
	systemInjections: NativeSystemInjection[];
};

const assistantProjectionSchema = z.object({
	text: z.string(),
	toolCalls: z.array(z.object({ id: z.string(), name: z.string(), input: jsonObjectSchema })),
});
type AssistantProjection = {
	text: string;
	toolCalls: { id: string; name: string; input: JsonObject }[];
};

// 保存済みのセッションから読み戻すため、外部入力として検証する。
const replayCarrierSchema = z.object({
	version: z.literal(1),
	message: nativeMessageSchema,
	projection: assistantProjectionSchema,
	initialSystemMessages: z.array(z.unknown()).optional(),
});
type ReplayCarrier = z.infer<typeof replayCarrierSchema>;

function sanitizeSurrogates(text: string): string {
	return text.replaceAll(/[\uD800-\uDFFF]/gu, "�");
}

function nativeToolUseId(id: string): string {
	return id.replaceAll(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64);
}

export function prepareMessages(messages: Message[], model: Model<Api>): Message[] {
	const toolCallIds = new Map<string, string>();
	return messages.map((message) => {
		if (message.role === "toolResult") {
			const id = toolCallIds.get(message.toolCallId);
			return id !== undefined && id !== message.toolCallId
				? { ...message, toolCallId: id }
				: message;
		}
		if (
			message.role !== "assistant" ||
			(message.provider === model.provider &&
				message.api === model.api &&
				message.model === model.id)
		) {
			return message;
		}
		return {
			...message,
			diagnostics: message.diagnostics?.filter((item) => item.type !== NATIVE_REPLAY_DIAGNOSTIC),
			content: message.content.flatMap((block): AssistantMessage["content"] => {
				// 署名は元のモデルでしか通らず、テキストで再生すると見える返答に読めてしまうため、他モデルの thinking は落とす。
				if (block.type === "thinking") return [];
				if (block.type === "text") return [{ type: "text", text: block.text }];
				const id = nativeToolUseId(block.id);
				toolCallIds.set(block.id, id);
				const { thoughtSignature: _thoughtSignature, ...toolCall } = block;
				return [{ ...toolCall, id }];
			}),
		};
	});
}

function assistantProjection(message: AssistantMessage): AssistantProjection {
	const text = message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
	const toolCalls = message.content
		.filter((block) => block.type === "toolCall")
		.map((block) => ({ id: block.id, name: block.name, input: toJsonObject(block.arguments) }));
	return { text, toolCalls };
}

function replayCarrier(message: AssistantMessage): ReplayCarrier | undefined {
	const diagnostic = message.diagnostics?.find((item) => item.type === NATIVE_REPLAY_DIAGNOSTIC);
	const parsed = replayCarrierSchema.safeParse(diagnostic?.details?.["carrier"]);
	return parsed.success ? parsed.data : undefined;
}

export function getInitialSystemMessages(messages: Message[]): unknown[] | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const value = replayCarrier(message)?.initialSystemMessages;
		if (value !== undefined) return structuredClone(value);
	}
	return undefined;
}

function projectionsEqual(left: AssistantProjection, right: AssistantProjection): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function imageBlock(block: ImageContent): Record<string, unknown> {
	return {
		type: "image",
		source: { type: "base64", media_type: block.mimeType, data: block.data },
	};
}

function userContent(content: string | (TextContent | ImageContent)[]): unknown[] {
	if (typeof content === "string") {
		return content === "" ? [] : [{ type: "text", text: sanitizeSurrogates(content) }];
	}
	return content.map((block) =>
		block.type === "text"
			? { type: "text", text: sanitizeSurrogates(block.text) }
			: imageBlock(block),
	);
}

function toolResultContent(message: ToolResultMessage): string | unknown[] {
	const hasImages = message.content.some((block) => block.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(
			message.content
				.filter((block): block is TextContent => block.type === "text")
				.map((block) => block.text)
				.join("\n"),
		);
	}
	return message.content.map((block) =>
		block.type === "text"
			? { type: "text", text: sanitizeSurrogates(block.text) }
			: imageBlock(block),
	);
}

function canonicalAssistantContent(message: AssistantMessage): NativeContentBlock[] {
	const blocks: NativeContentBlock[] = [];
	for (const block of message.content) {
		if (block.type === "text" && block.text.trim() !== "") {
			blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
		} else if (
			block.type === "thinking" &&
			block.thinking.trim() !== "" &&
			block.thinkingSignature !== undefined &&
			block.thinkingSignature !== ""
		) {
			if (block.redacted === true) {
				blocks.push({ type: "redacted_thinking", data: block.thinkingSignature });
			} else {
				blocks.push({
					type: "thinking",
					thinking: sanitizeSurrogates(block.thinking),
					signature: block.thinkingSignature,
				});
			}
		} else if (block.type === "toolCall") {
			blocks.push({
				type: "tool_use",
				id: block.id,
				name: `${TOOL_PREFIX}${block.name}`,
				input: structuredClone(block.arguments),
			});
		}
	}
	return blocks;
}

function assistantContent(message: AssistantMessage): NativeContentBlock[] {
	const carrier = replayCarrier(message);
	if (carrier && projectionsEqual(assistantProjection(message), carrier.projection)) {
		return structuredClone(carrier.message.content);
	}

	// 見える内容が変わったのに古い署名付き thinking を戻してはいけない。carrier の無い古いメッセージは正規化したブロックで再生する。
	if (carrier) {
		return canonicalAssistantContent({
			...message,
			content: message.content.filter((block) => block.type !== "thinking"),
		});
	}
	return canonicalAssistantContent(message);
}

export function prepareFrames(messages: Message[]): NativeFrame[] {
	const frames: NativeFrame[] = [];

	for (const message of messages) {
		if (message.role === "system") continue;

		let role: "user" | "assistant";
		let blocks: unknown[];

		if (message.role === "user") {
			role = "user";
			blocks = userContent(message.content);
		} else if (message.role === "assistant") {
			role = "assistant";
			blocks = assistantContent(message);
		} else {
			role = "user";
			blocks = [
				{
					type: "tool_result",
					tool_use_id: message.toolCallId,
					content: toolResultContent(message),
					is_error: message.isError,
				},
			];
		}

		if (blocks.length === 0) continue;
		const previous = frames.at(-1);
		if (role === "user" && previous?.type === "user") {
			previous.message.content.push(...blocks);
		} else {
			frames.push({ type: role, message: { role, content: blocks } });
		}
	}

	const final = frames.at(-1);
	if (final?.type !== "user" || final.message.content.length === 0) {
		throw new Error("Claude Code history must end in a non-empty user or tool-result message");
	}

	for (const frame of frames.slice(0, -1)) {
		if (frame.type === "user") frame.shouldQuery = false;
	}
	return frames;
}

function withoutNullVariant(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(withoutNullVariant);
	if (!isRecord(schema)) return schema;

	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) output[key] = withoutNullVariant(value);

	const type = output["type"];
	if (Array.isArray(type) && type.includes("null")) {
		const remaining = type.filter((value) => value !== "null");
		output["type"] = remaining.length === 1 ? remaining[0] : remaining;
	}

	const anyOf = output["anyOf"];
	if (Array.isArray(anyOf)) {
		const nonNull = anyOf.filter((branch) => !(isRecord(branch) && branch["type"] === "null"));
		if (nonNull.length === 1 && nonNull.length !== anyOf.length) {
			const replacement: unknown = nonNull[0];
			delete output["anyOf"];
			if (isRecord(replacement)) Object.assign(output, replacement);
		}
	}
	return output;
}

export function normalizeInputSchema(schema: unknown): Record<string, unknown> {
	const stripped = withoutNullVariant(schema);
	const normalized: Record<string, unknown> = isRecord(stripped) ? stripped : {};
	for (const key of ["oneOf", "allOf", "anyOf"]) delete normalized[key];
	if (normalized["type"] == null || normalized["type"] === "") {
		normalized["type"] = "object";
	}
	if (normalized["type"] === "object" && !isRecord(normalized["properties"])) {
		normalized["properties"] = {};
	}
	return normalized;
}

export type ToolManifestEntry = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
};

type NativeTool = {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
};

export function prepareTools(tools: Tool[]): {
	manifest: ToolManifestEntry[];
	nativeTools: NativeTool[];
} {
	const names = new Set<string>();
	const manifest: ToolManifestEntry[] = [];
	const nativeTools: NativeTool[] = [];

	for (const tool of tools) {
		if (!/^[A-Za-z0-9_-]{1,50}$/u.test(tool.name) || names.has(tool.name)) {
			throw new Error(
				"Claude Code tool names must be unique ASCII identifiers of at most 50 characters",
			);
		}
		names.add(tool.name);
		const schema = normalizeInputSchema(tool.parameters);
		manifest.push({ name: tool.name, description: tool.description, inputSchema: schema });
		nativeTools.push({
			name: `${TOOL_PREFIX}${tool.name}`,
			description: tool.description,
			input_schema: schema,
		});
	}
	return { manifest, nativeTools };
}

function nativeSystemBlocks(message: SystemMessage): Record<string, unknown>[] {
	const blocks: Record<string, unknown>[] = [];
	const text = renderSystemMessageUpdate(message);
	if (text !== "") blocks.push({ type: "text", text: sanitizeSurrogates(text) });
	for (const tool of message.toolsRemoved ?? []) {
		blocks.push({
			type: "tool_removal",
			tool: { type: "tool_reference", name: `${TOOL_PREFIX}${tool.name}` },
		});
	}
	for (const tool of message.toolsAdded ?? []) {
		blocks.push({
			type: "tool_addition",
			tool: { type: "tool_reference", name: `${TOOL_PREFIX}${tool.name}` },
		});
	}
	return blocks;
}

// 途中のツール増減を Anthropic のネイティブ表現にしてプロンプトキャッシュを保つ。プレースホルダーは最初の要求から遅延ツールの足場を固定するため。
export function prepareNativeTranscript(
	messages: Message[],
	supported: boolean,
): NativeTranscriptPlan | undefined {
	const initial = getInitialSystemMessage(messages);
	const initialTools = initial?.toolsAdded ?? [];
	// oxlint-disable-next-line typescript/no-deprecated -- 上流と同じく、ツールの再定義があればネイティブ表現をやめて今のツールを全部送る。
	if (!supported || initialTools.length === 0 || hasToolRedefinitions(messages)) return undefined;

	const declared = getDeclaredTools(messages);
	const prepared = prepareTools(declared);
	const nativeByName = new Map(
		prepared.nativeTools.map((tool) => [tool.name.slice(TOOL_PREFIX.length), tool]),
	);
	const nativeTool = (name: string): Record<string, unknown> => {
		const tool = nativeByName.get(name);
		if (tool === undefined) throw new Error(`Claude Code lost the declaration of tool ${name}`);
		return structuredClone(tool);
	};
	const initialNames = new Set(initialTools.map((tool) => tool.name));
	const initialNative = initialTools.map((tool) => nativeTool(tool.name));
	const lastInitial = initialNative.at(-1);
	if (lastInitial !== undefined) lastInitial["cache_control"] = { type: "ephemeral", ttl: "1h" };
	const laterNative = declared
		.filter((tool) => !initialNames.has(tool.name))
		.map((tool) => Object.assign(nativeTool(tool.name), { defer_loading: true }));

	const systemInjections: NativeSystemInjection[] = [];
	let pending: Record<string, unknown>[][] = [];
	let assistantOrdinal = 0;
	const flush = (beforeAssistant: number | null) => {
		for (const content of pending) systemInjections.push({ beforeAssistant, content });
		pending = [];
	};

	for (const message of messages.slice(1)) {
		if (message.role === "system") {
			const blocks = nativeSystemBlocks(message);
			if (blocks.length > 0) pending.push(blocks);
		} else if (message.role === "assistant" && assistantContent(message).length > 0) {
			flush(assistantOrdinal);
			assistantOrdinal += 1;
		}
	}
	flush(null);

	return {
		requestTools: [...initialNative, structuredClone(DEFERRED_TOOL_PLACEHOLDER), ...laterNative],
		systemInjections,
	};
}

export function buildExtraBody(
	modelId: string,
	nativeTools: Record<string, unknown>[],
	options?: SimpleStreamOptions,
): Record<string, unknown> {
	const body: Record<string, unknown> = { tools: nativeTools };
	if (options?.maxTokens !== undefined) body["max_tokens"] = options.maxTokens;

	if (options?.reasoning !== undefined) {
		if (supportsAdaptiveThinking(modelId)) {
			body["thinking"] = { type: "adaptive", display: "summarized" };
		}
		body["output_config"] = {
			effort: options.reasoning === "minimal" ? "low" : options.reasoning,
		};
	} else if (!supportsDisabledThinking(modelId)) {
		// Opus 5.5 などは disabled を拒むため、適応的思考の最小の effort で代える。
		body["thinking"] = { type: "adaptive" };
		body["output_config"] = { effort: "low" };
	} else {
		body["thinking"] = { type: "disabled" };
		// thinking が無効だと clear-thinking の編集は不正になる。
		body["context_management"] = { edits: [] };
	}
	return body;
}

export function makeReplayDiagnostic(
	message: NativeMessage,
	output: AssistantMessage,
	initialSystemMessages?: unknown[],
): AssistantMessageDiagnostic {
	const carrier = {
		version: 1,
		message: structuredClone(message),
		projection: assistantProjection(output),
		...(initialSystemMessages === undefined
			? {}
			: { initialSystemMessages: structuredClone(initialSystemMessages) }),
	};
	return {
		type: NATIVE_REPLAY_DIAGNOSTIC,
		timestamp: Date.now(),
		details: { carrier: toJsonObject(carrier) },
	};
}
