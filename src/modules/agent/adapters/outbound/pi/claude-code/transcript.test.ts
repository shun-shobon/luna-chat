import type { Api, AssistantMessage, Message, Model, Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { CLAUDE_CODE_MODELS } from "./model-catalog";
import {
	buildExtraBody,
	getInitialSystemMessages,
	makeReplayDiagnostic,
	normalizeInputSchema,
	prepareFrames,
	prepareMessages,
	prepareNativeTranscript,
	prepareTools,
	TOOL_PREFIX,
} from "./transcript";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function claudeModel(id: string): Model<Api> {
	const model = CLAUDE_CODE_MODELS.find((candidate) => candidate.id === id);
	if (model === undefined) throw new Error(`missing ${id}`);
	return model;
}

const EMPTY_PARAMETERS = { type: "object", properties: {} };

function tool(name: string, parameters: object = EMPTY_PARAMETERS): Tool {
	return { name, description: name, parameters };
}

function assistant(
	content: AssistantMessage["content"],
	overrides: Partial<AssistantMessage> = {},
) {
	return {
		role: "assistant",
		api: "claude-code-stream-json",
		provider: "claude-code",
		model: "claude-sonnet-5-5",
		content,
		usage,
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	} satisfies AssistantMessage;
}

describe("prepareFrames", () => {
	it("ツール結果をまとめ、最後以外の user を履歴の再生として送る", () => {
		const messages: Message[] = [
			{ role: "system", content: "system", timestamp: 0 },
			{ role: "user", content: "inspect", timestamp: 1 },
			assistant(
				[
					{ type: "thinking", thinking: "private", thinkingSignature: "signed" },
					{ type: "text", text: "checking" },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
					{ type: "toolCall", id: "t2", name: "read", arguments: { path: "b" } },
				],
				{ stopReason: "toolUse" },
			),
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "read",
				content: [{ type: "text", text: "A" }],
				isError: false,
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "t2",
				toolName: "read",
				content: [{ type: "text", text: "B" }],
				isError: false,
				timestamp: 2,
			},
		];

		const frames = prepareFrames(messages);
		expect(frames).toHaveLength(3);
		expect(frames[0]?.shouldQuery).toBe(false);
		expect(frames[1]?.type).toBe("assistant");
		expect(frames[1]?.message.content[2]).toMatchObject({ name: `${TOOL_PREFIX}read` });
		expect(frames[2]?.message.content).toHaveLength(2);
		expect(frames[2]?.shouldQuery).toBeUndefined();
	});

	it("最後が user でない履歴は送らない", () => {
		expect(() =>
			prepareFrames([
				{ role: "user", content: "go", timestamp: 0 },
				assistant([{ type: "text", text: "done" }]),
			]),
		).toThrow("Claude Code history must end in a non-empty user or tool-result message");
	});

	it("見える内容が変わらない間だけ署名付きのネイティブブロックを再生する", () => {
		const message = assistant([
			{ type: "thinking", thinking: "private", thinkingSignature: "signed" },
			{ type: "text", text: "visible" },
		]);
		const native = {
			id: "m1",
			role: "assistant" as const,
			content: [
				{ type: "thinking" as const, thinking: "private", signature: "signed", extra: "preserved" },
				{ type: "text" as const, text: "visible" },
			],
			stop_reason: "end_turn",
		};
		const nativeSystems = [{ role: "system", content: [{ type: "text", text: "environment" }] }];
		message.diagnostics = [makeReplayDiagnostic(native, message, nativeSystems)];

		expect(getInitialSystemMessages([message])).toEqual(nativeSystems);
		const original = prepareFrames([
			{ role: "user", content: "go", timestamp: 0 },
			message,
			{ role: "user", content: "again", timestamp: 2 },
		]);
		expect(original[1]?.message.content[0]).toMatchObject({ extra: "preserved" });

		message.content[1] = { type: "text", text: "edited" };
		const edited = prepareFrames([
			{ role: "user", content: "go", timestamp: 0 },
			message,
			{ role: "user", content: "again", timestamp: 2 },
		]);
		expect(edited[1]?.message.content).toEqual([{ type: "text", text: "edited" }]);
	});

	it("形の崩れた carrier は使わず、正規化したブロックで再生する", () => {
		const message = assistant([
			{ type: "thinking", thinking: "private", thinkingSignature: "signed" },
			{ type: "text", text: "visible" },
		]);
		message.diagnostics = [
			{
				type: "claude-code.native-assistant.v1",
				timestamp: 0,
				details: { carrier: { version: 2, message: "broken" } },
			},
		];

		expect(getInitialSystemMessages([message])).toBeUndefined();
		const frames = prepareFrames([
			{ role: "user", content: "go", timestamp: 0 },
			message,
			{ role: "user", content: "again", timestamp: 2 },
		]);
		expect(frames[1]?.message.content).toEqual([
			{ type: "thinking", thinking: "private", signature: "signed" },
			{ type: "text", text: "visible" },
		]);
	});
});

describe("prepareNativeTranscript", () => {
	it("キャッシュを保つツール宣言と時系列の system の変化を組み立てる", () => {
		const alpha = tool("alpha");
		const beta = tool("beta");
		const messages: Message[] = [
			{ role: "system", content: "base", toolsAdded: [alpha], timestamp: 0 },
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "system", content: "beta is available", toolsAdded: [beta], timestamp: 2 },
			assistant([{ type: "text", text: "one" }], { timestamp: 3 }),
			{ role: "system", content: "alpha is gone", toolsRemoved: [{ name: "alpha" }], timestamp: 4 },
			{ role: "user", content: "second", timestamp: 5 },
		];

		const plan = prepareNativeTranscript(messages, true);
		expect(
			plan?.requestTools.map((entry) => [entry["name"], entry["defer_loading"] ?? false]),
		).toEqual([
			[`${TOOL_PREFIX}alpha`, false],
			["__pi_deferred_placeholder__", true],
			[`${TOOL_PREFIX}beta`, true],
		]);
		expect(plan?.requestTools[0]?.["cache_control"]).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(plan?.systemInjections).toEqual([
			{
				beforeAssistant: 0,
				content: [
					{ type: "text", text: "beta is available" },
					{ type: "tool_addition", tool: { type: "tool_reference", name: `${TOOL_PREFIX}beta` } },
				],
			},
			{
				beforeAssistant: null,
				content: [
					{ type: "text", text: "alpha is gone" },
					{ type: "tool_removal", tool: { type: "tool_reference", name: `${TOOL_PREFIX}alpha` } },
				],
			},
		]);

		expect(prepareNativeTranscript(messages, false)).toBeUndefined();
		expect(
			prepareNativeTranscript(
				[
					{ role: "system", content: "base", timestamp: 0 },
					{ role: "system", content: "late", toolsAdded: [alpha], timestamp: 1 },
					{ role: "user", content: "go", timestamp: 2 },
				],
				true,
			),
		).toBeUndefined();
		expect(
			prepareNativeTranscript(
				[
					...messages,
					{
						role: "system",
						content: "",
						toolsAdded: [{ ...alpha, description: "changed" }],
						timestamp: 6,
					},
				],
				true,
			),
		).toBeUndefined();
	});
});

describe("prepareTools と buildExtraBody", () => {
	it("ツールのスキーマを正規化する", () => {
		const prepared = prepareTools([
			tool("probe", {
				type: "object",
				properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } },
				required: ["value"],
			}),
		]);
		expect(prepared.manifest[0]?.name).toBe("probe");
		expect(prepared.nativeTools[0]?.name).toBe(`${TOOL_PREFIX}probe`);
		expect(prepared.manifest[0]?.inputSchema).toEqual({
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
		});
		expect(normalizeInputSchema({ oneOf: [{ type: "object" }, { type: "string" }] })).toEqual({
			type: "object",
			properties: {},
		});
	});

	it("Claude Code が扱えないツール名や重複は断る", () => {
		expect(() => prepareTools([tool("has space")])).toThrow(/unique ASCII identifiers/u);
		expect(() => prepareTools([tool("same"), tool("same")])).toThrow(/unique ASCII identifiers/u);
	});

	it("思考の指定をモデルの対応に合わせる", () => {
		expect(buildExtraBody("claude-sonnet-5-5", [], { reasoning: "minimal" })).toEqual({
			tools: [],
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "low" },
		});
		expect(buildExtraBody("claude-opus-5-5", [], { reasoning: "high", maxTokens: 10 })).toEqual({
			tools: [],
			max_tokens: 10,
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "high" },
		});
		// Haiku 5.5 は thinking.type: disabled を受け付ける。
		expect(buildExtraBody("claude-haiku-5-5", [], {})).toEqual({
			tools: [],
			thinking: { type: "disabled" },
			context_management: { edits: [] },
		});
		// Opus 5.5 などは disabled を拒む（上流 issue #2）。
		for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"]) {
			expect(buildExtraBody(id, [], {})).toEqual({
				tools: [],
				thinking: { type: "adaptive" },
				output_config: { effort: "low" },
			});
		}
		expect(() => buildExtraBody("claude-unknown", [], {})).toThrow(
			"Unknown Claude Code model: claude-unknown",
		);
	});
});

describe("prepareMessages", () => {
	it("ネイティブの再生は同じモデルだけに使い、元の履歴を変えない", () => {
		const model = claudeModel("claude-sonnet-5-5");
		const message = assistant([
			{
				type: "thinking",
				thinking: "[Reasoning redacted]",
				thinkingSignature: "opaque",
				redacted: true,
			},
			{ type: "text", text: "visible" },
		]);
		const native = {
			role: "assistant" as const,
			content: [
				{ type: "redacted_thinking" as const, data: "opaque" },
				{ type: "text" as const, text: "visible" },
			],
		};
		message.diagnostics = [makeReplayDiagnostic(native, message)];
		const messages: Message[] = [
			{ role: "user", content: "go", timestamp: 0 },
			message,
			{ role: "user", content: "again", timestamp: 2 },
		];
		const original = structuredClone(messages);

		const sameModel = prepareFrames(prepareMessages(messages, model));
		expect(sameModel[1]?.message.content).toEqual(native.content);
		const otherModel = prepareFrames(prepareMessages(messages, claudeModel("claude-opus-5-5")));
		expect(otherModel[1]?.message.content).toEqual([{ type: "text", text: "visible" }]);
		expect(messages).toEqual(original);
	});

	it("他のプロバイダーのツール呼び出し ID を直し、思考を落とす", () => {
		const id = `call_abc|fc_${"x".repeat(400)}`;
		const foreign = assistant(
			[
				{ type: "thinking", thinking: "", thinkingSignature: "encrypted" },
				{ type: "thinking", thinking: "inspect the file", thinkingSignature: "foreign-thinking" },
				{ type: "text", text: "checking", textSignature: "foreign-text" },
				{
					type: "toolCall",
					id,
					name: "read",
					arguments: { path: "a" },
					thoughtSignature: "foreign-tool",
				},
			],
			{ api: "openai-responses", provider: "openai", model: "gpt-5", stopReason: "toolUse" },
		);
		const messages: Message[] = [
			{ role: "user", content: "go", timestamp: 0 },
			foreign,
			{
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: "A" }],
				isError: false,
				timestamp: 2,
			},
		];
		const original = structuredClone(messages);
		const prepared = prepareMessages(messages, claudeModel("claude-sonnet-5-5"));
		const preparedAssistant = prepared[1];
		if (preparedAssistant?.role !== "assistant") throw new Error("expected assistant");
		expect(preparedAssistant.content[0]).toEqual({ type: "text", text: "checking" });
		expect(preparedAssistant.content[1]).not.toHaveProperty("thoughtSignature");
		const frames = prepareFrames(prepared);

		const toolUse = (frames[1]?.message.content ?? []) as { type: string; id?: string }[];
		expect(toolUse.map((block) => block.type)).toEqual(["text", "tool_use"]);
		const nativeId = toolUse[1]?.id;
		expect(nativeId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u);
		expect(frames[2]?.message.content[0]).toMatchObject({ tool_use_id: nativeId });
		expect(messages).toEqual(original);
	});
});
