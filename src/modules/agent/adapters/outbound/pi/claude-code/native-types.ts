import type { JsonObject } from "@earendil-works/pi-ai";
import { z } from "zod";

import { rateLimitInfoSchema } from "./billing";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value != null && !Array.isArray(value);
}

export const jsonObjectSchema = z.record(z.string(), z.json());

// pi の diagnostics は JsonObject しか持てないため、自前で組み立てた値もここを通して JSON であることを確かめる。
export function toJsonObject(value: unknown): JsonObject {
	return jsonObjectSchema.parse(value);
}

const optionalNumber = z.number().nullish();

export const nativeUsageSchema = z.looseObject({
	input_tokens: z.number(),
	output_tokens: z.number(),
	cache_read_input_tokens: optionalNumber,
	cache_creation_input_tokens: optionalNumber,
	cache_creation: z.looseObject({ ephemeral_1h_input_tokens: optionalNumber }).nullish(),
	output_tokens_details: z.looseObject({ thinking_tokens: optionalNumber }).nullish(),
});
export type NativeUsage = z.infer<typeof nativeUsageSchema>;

const partialUsageSchema = nativeUsageSchema.partial().extend({
	input_tokens: optionalNumber,
	output_tokens: optionalNumber,
});
export type PartialNativeUsage = z.infer<typeof partialUsageSchema>;

const nativeContentBlockSchema = z.discriminatedUnion("type", [
	z.looseObject({ type: z.literal("text"), text: z.string() }),
	z.looseObject({
		type: z.literal("thinking"),
		thinking: z.string(),
		signature: z.string().optional(),
	}),
	z.looseObject({ type: z.literal("redacted_thinking"), data: z.string() }),
	z.looseObject({
		type: z.literal("tool_use"),
		id: z.string(),
		name: z.string(),
		input: z.record(z.string(), z.unknown()),
	}),
]);
export type NativeContentBlock = z.infer<typeof nativeContentBlockSchema>;

export const nativeMessageSchema = z.looseObject({
	id: z.string().optional(),
	role: z.literal("assistant"),
	content: z.array(nativeContentBlockSchema),
	usage: nativeUsageSchema.optional(),
	stop_reason: z.string().nullish(),
	stop_sequence: z.string().nullish(),
});
export type NativeMessage = z.infer<typeof nativeMessageSchema>;

export type NativeFrame = {
	type: "user" | "assistant";
	message: {
		role: "user" | "assistant";
		content: unknown[];
	};
	shouldQuery?: false;
};

const nativeResultSchema = z.looseObject({
	type: z.literal("result"),
	subtype: z.string().optional(),
	is_error: z.boolean().optional(),
	num_turns: z.number().optional(),
	// 選んだ側だけを使う時点で検証する。使わない側の形が崩れていても run を落とさない。
	usage: z.unknown().optional(),
	user_message_uuids: z.array(z.string()).optional(),
});
export type NativeResult = z.infer<typeof nativeResultSchema>;

const deltaSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text_delta"), text: z.string() }),
	z.object({ type: z.literal("thinking_delta"), thinking: z.string() }),
	z.object({ type: z.literal("signature_delta"), signature: z.string() }),
	z.object({ type: z.literal("input_json_delta"), partial_json: z.string() }),
]);
const KNOWN_DELTA_TYPES = new Set<string>(
	deltaSchema.options.map((option) => option.shape.type.value),
);

const anthropicStreamEventSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("message_start"), message: nativeMessageSchema }),
	z.object({
		type: z.literal("content_block_start"),
		index: z.number(),
		content_block: nativeContentBlockSchema,
	}),
	z.object({ type: z.literal("content_block_delta"), index: z.number(), delta: deltaSchema }),
	z.object({ type: z.literal("content_block_stop"), index: z.number() }),
	z.object({
		type: z.literal("message_delta"),
		delta: z.looseObject({
			stop_reason: z.string().nullish(),
			stop_sequence: z.string().nullish(),
		}),
		usage: partialUsageSchema.nullish(),
	}),
	z.object({ type: z.literal("message_stop") }),
	z.object({
		type: z.literal("error"),
		error: z.object({ type: z.string().nullish(), message: z.string().nullish() }).nullish(),
	}),
]);
export type AnthropicStreamEvent = z.infer<typeof anthropicStreamEventSchema>;
const KNOWN_EVENT_TYPES = new Set<string>(
	anthropicStreamEventSchema.options.map((option) => option.shape.type.value),
);

const typedSchema = z.looseObject({ type: z.string() });

// ping や未知のデルタは上流でも何もしないため、捨てて undefined を返す。知っている種類の形が崩れていれば例外にする。
export function parseAnthropicStreamEvent(raw: unknown): AnthropicStreamEvent | undefined {
	const typed = typedSchema.parse(raw);
	if (!KNOWN_EVENT_TYPES.has(typed.type)) return undefined;
	if (typed.type === "content_block_delta") {
		const delta = typedSchema.safeParse(typed["delta"]);
		if (delta.success && !KNOWN_DELTA_TYPES.has(delta.data.type)) return undefined;
	}
	return anthropicStreamEventSchema.parse(raw);
}

const nativeOutputEventSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("assistant"),
		message: nativeMessageSchema,
		error: z.unknown().optional(),
	}),
	nativeResultSchema,
	z.object({ type: z.literal("stream_event"), event: z.unknown() }),
	z.object({ type: z.literal("rate_limit_event"), rate_limit_info: rateLimitInfoSchema.nullish() }),
]);
type RawNativeOutputEvent = z.infer<typeof nativeOutputEventSchema>;
export type NativeOutputEvent =
	| Exclude<RawNativeOutputEvent, { type: "stream_event" }>
	| { type: "stream_event"; event: AnthropicStreamEvent };
const KNOWN_OUTPUT_TYPES = new Set<string>(
	nativeOutputEventSchema.options.map((option) => option.shape.type.value),
);

// system や user（MCP の拒否結果）など、run が読まない行は捨てる。
export function parseNativeOutputEvent(raw: unknown): NativeOutputEvent | undefined {
	const typed = typedSchema.parse(raw);
	if (!KNOWN_OUTPUT_TYPES.has(typed.type)) return undefined;
	const event = nativeOutputEventSchema.parse(raw);
	if (event.type !== "stream_event") return event;
	const inner = parseAnthropicStreamEvent(event.event);
	return inner === undefined ? undefined : { type: "stream_event", event: inner };
}
