import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, describe, expect, it } from "vitest";

import { closeClaudeProcesses } from "./claude-cli";
import { CLAUDE_CODE_MODELS } from "./model-catalog";
import { streamClaudeCode } from "./stream";
import { AUTH_STATUS_OK, createFakeClaude } from "./testing";
import type { FakeClaude } from "./testing";

const fakes: FakeClaude[] = [];

afterEach(async () => {
	await closeClaudeProcesses();
	await Promise.all(
		fakes.splice(0).map(async (fake) => {
			await fake.cleanup();
		}),
	);
});

function findOpus(): Model<Api> {
	const model = CLAUDE_CODE_MODELS.find((candidate) => candidate.id === "claude-opus-5-5");
	if (model === undefined) throw new Error("missing claude-opus-5-5");
	return model;
}
const opus = findOpus();

const context = normalizeContext({
	systemPrompt: "system",
	messages: [{ role: "user", content: [{ type: "text", text: "count errors" }], timestamp: 0 }],
});

function fakeTurn(
	content: string,
	events: string,
	stopReason: string,
	resultSubtype: string,
): string {
	return `import readline from "node:readline";
${AUTH_STATUS_OK}
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  const usage = {input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 0};
  const content = ${content};
  for (const event of ${events}) console.log(JSON.stringify({type: "stream_event", event}));
  console.log(JSON.stringify({type: "assistant", message: {id: "m_fake", role: "assistant", content, stop_reason: "${stopReason}", usage}}));
  console.log(JSON.stringify({type: "result", subtype: "${resultSubtype}", is_error: ${resultSubtype !== "success"}, usage}));
}
`;
}

async function run(body: string): Promise<{ message: AssistantMessage; events: string[] }> {
	const fake = await createFakeClaude(body);
	fakes.push(fake);
	const stream = streamClaudeCode(opus, context, {
		env: fake.env,
		timeoutMs: 5000,
		cacheRetention: "none",
	});
	const events: string[] = [];
	for await (const event of stream) events.push(event.type);
	return { message: await stream.result(), events };
}

describe("streamClaudeCode", () => {
	it("宣言していないツールの呼び出しもそのまま渡す", async () => {
		const { message } = await run(
			fakeTurn(
				`[{type: "tool_use", id: "tool_fake", name: "mcp__pi__aggregate_rum_events", input: {query: "*"}}]`,
				`[
    {type: "message_start", message: {id: "m_fake", role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: {type: "tool_use", id: "tool_fake", name: "mcp__pi__aggregate_rum_events", input: {}}},
    {type: "content_block_delta", index: 0, delta: {type: "input_json_delta", partial_json: '{"query":"*"}'}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "tool_use"}, usage},
    {type: "message_stop"}
  ]`,
				"tool_use",
				"error_max_turns",
			),
		);
		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toEqual([
			{
				type: "toolCall",
				id: "tool_fake",
				name: "aggregate_rum_events",
				arguments: { query: "*" },
			},
		]);
	}, 10_000);

	it("テキストの応答を流し、使用量と再生用の診断を付ける", async () => {
		const { message, events } = await run(
			fakeTurn(
				`[{type: "text", text: "hello"}]`,
				`[
    {type: "message_start", message: {id: "m_fake", role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
    {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "hel"}},
    {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "lo"}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "end_turn"}, usage},
    {type: "message_stop"}
  ]`,
				"end_turn",
				"success",
			),
		);
		expect(message.stopReason).toBe("stop");
		expect(message.responseId).toBe("m_fake");
		expect(message.content).toEqual([{ type: "text", text: "hello" }]);
		expect(message.usage).toMatchObject({ input: 3, output: 1, cacheRead: 2, totalTokens: 6 });
		expect(message.diagnostics?.map((diagnostic) => diagnostic.type)).toEqual([
			"claude-code.native-assistant.v1",
			"claude-code.turn-relay",
		]);
		expect(events).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
	}, 10_000);

	it("増分と最終の応答が食い違えば失敗にする", async () => {
		const { message } = await run(
			fakeTurn(
				`[{type: "text", text: "different"}]`,
				`[
    {type: "message_start", message: {id: "m_fake", role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: {type: "text", text: "hello"}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "end_turn"}, usage},
    {type: "message_stop"}
  ]`,
				"end_turn",
				"success",
			),
		);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe(
			"Claude Code final response differs from its incremental stream",
		);
	}, 10_000);

	it("拒否で止まった応答はエラーにする", async () => {
		const { message } = await run(
			fakeTurn(
				`[{type: "text", text: "no"}]`,
				`[
    {type: "message_start", message: {id: "m_fake", role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: {type: "text", text: "no"}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "refusal"}, usage},
    {type: "message_stop"}
  ]`,
				"refusal",
				"success",
			),
		);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("The model refused to complete the request");
	}, 10_000);

	it("Claude Code が無ければエラーのメッセージで終える", async () => {
		const stream = streamClaudeCode(opus, context, { env: { PATH: "" }, timeoutMs: 1000 });
		const message = await stream.result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe(
			"Claude Code is not installed. Install it so that `claude` is on PATH.",
		);
	});

	it("中断されたら aborted で終える", async () => {
		const controller = new AbortController();
		controller.abort();
		const stream = streamClaudeCode(opus, context, { signal: controller.signal });
		const message = await stream.result();
		expect(message.stopReason).toBe("aborted");
	});
});
