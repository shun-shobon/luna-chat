import { readFile } from "node:fs/promises";
import * as http from "node:http";
import { join } from "node:path";

import { fauxAssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	cachedClaudeProcessCount,
	closeClaudeProcesses,
	getClaudeStatus,
	keepSpareClaudeProcess,
	rewriteInitialRequest,
	runClaudeRequest,
} from "./claude-cli";
import type { NativeFrame } from "./native-types";
import { AUTH_STATUS_OK, createFakeClaude } from "./testing";
import type { FakeClaude } from "./testing";

type Block = Record<string, unknown>;
type WireMessage = { role: string; content: unknown };

const text = (value: string): Block => ({ type: "text", text: value });
const memory = "<system-reminder>[MEMORY.md contents]</system-reminder>";
const account = "<system-reminder># userEmail\nuser@example.com</system-reminder>";

function framesFor(messages: WireMessage[]): NativeFrame[] {
	return messages
		.filter((message) => message.role !== "system")
		.map((message) => {
			const role = message.role === "assistant" ? "assistant" : "user";
			const content: unknown = structuredClone(message.content);
			return { type: role, message: { role, content: Array.isArray(content) ? content : [] } };
		});
}

function parseMessages(body: Buffer): WireMessage[] {
	const parsed = JSON.parse(body.toString("utf8")) as { messages: WireMessage[] };
	return parsed.messages;
}

function rewrite(
	wire: WireMessage[],
	frames: NativeFrame[],
	initialSystemMessages?: unknown[],
	injections?: Parameters<typeof rewriteInitialRequest>[3],
): WireMessage[] {
	const body = Buffer.from(JSON.stringify({ messages: wire }));
	return parseMessages(rewriteInitialRequest(body, frames, initialSystemMessages, injections));
}

const withoutMarkers = (value: unknown): unknown =>
	JSON.parse(
		JSON.stringify(value, (key, child: unknown) => (key === "cache_control" ? undefined : child)),
	);

const blocks = (message: WireMessage | undefined): Block[] => (message?.content ?? []) as Block[];

const fakes: FakeClaude[] = [];

afterEach(async () => {
	await closeClaudeProcesses();
	await Promise.all(
		fakes.splice(0).map(async (fake) => {
			await fake.cleanup();
		}),
	);
});

async function fakeClaude(body: string): Promise<FakeClaude> {
	const fake = await createFakeClaude(body);
	fakes.push(fake);
	return fake;
}

describe("rewriteInitialRequest", () => {
	it("Claude Code のネイティブなリマインダーとキャッシュの区切りを安定させる", () => {
		const initialSystemMessages = [
			{
				role: "system",
				content: [
					{
						type: "text",
						text: "environment reminder\ndate reminder",
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
				],
			},
		];
		const canonical = [
			{ role: "user", content: [text("inspect")] },
			{ role: "assistant", content: [text("first reply")] },
			{ role: "user", content: [text("follow up")] },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: "old result" }],
			},
			{ role: "assistant", content: [{ type: "tool_use", id: "t2", name: "read", input: {} }] },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t2", content: "current result" }],
			},
		];
		const current = [
			{ role: "user", content: [text("changed reminder"), text("inspect")] },
			{ role: "system", content: "environment reminder" },
			{ role: "assistant", content: [text("first reply")] },
			{ role: "user", content: [text(account), text("follow up")] },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: "old result" }],
			},
			{ role: "assistant", content: [{ type: "tool_use", id: "t2", name: "read", input: {} }] },
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "t2", content: `current result\n${account}` },
				],
			},
			{
				role: "system",
				content: [
					{ type: "text", text: "date reminder", cache_control: { type: "ephemeral", ttl: "1h" } },
				],
			},
		];

		const rewritten = rewrite(current, framesFor(canonical), initialSystemMessages);
		expect(rewritten).toHaveLength(8);
		expect(blocks(rewritten[1])[0]?.["text"]).toBe("environment reminder\ndate reminder");
		expect(blocks(rewritten[1])[0]?.["cache_control"]).toBeUndefined();
		expect(withoutMarkers(rewritten.filter((message) => message.role !== "system"))).toEqual(
			withoutMarkers(canonical),
		);
		expect(blocks(rewritten[5]).at(-1)?.["cache_control"]).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
		expect(blocks(rewritten.at(-1)).at(-1)?.["cache_control"]).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
	});

	it("最初の user にリマインダーが無くても後のリマインダーを落とす（上流 issue #27）", () => {
		const canonical = [
			{ role: "user", content: [text("inspect")] },
			{ role: "assistant", content: [text("first reply")] },
			{ role: "user", content: [text("follow up")] },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] },
		];
		const wire = [
			{ role: "user", content: [text("inspect")] },
			{ role: "assistant", content: [text("first reply")] },
			{ role: "user", content: [text(memory), text(account), text("follow up")] },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "t1", content: `result\n${memory}${account}` },
				],
			},
		];
		expect(rewrite(wire, framesFor(canonical))).toEqual(canonical);
		expect(
			withoutMarkers(
				rewrite(wire, framesFor(canonical), [
					{ role: "system", content: "environment reminder" },
				]).filter((message) => message.role !== "system"),
			),
		).toEqual(canonical);
	});

	it("ツール結果の末尾のリマインダーを区切りや組み合わせによらず落とす", () => {
		const frames = framesFor([
			{ role: "user", content: [text("inspect")] },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] },
		]);
		for (const tail of [
			`\n${memory}\n${account}`,
			`\n\n${memory}\n\n${account}`,
			`\n\n${account}`,
			`\n${account}`,
			account,
		]) {
			const rewritten = rewrite(
				[
					{ role: "user", content: [text("inspect")] },
					{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
					{
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "t1", content: `result${tail}` }],
					},
				],
				frames,
			);
			expect(blocks(rewritten[2])[0]?.["content"]).toBe("result");
		}
	});

	it("配列のツール結果からリマインダーを落とし、Claude Code の画像を残す", () => {
		const image = {
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "original" },
		};
		const resized = {
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "resized" },
		};
		const note = text(
			"[Image: original 4000x4000, displayed at 2000x2000. Multiply coordinates by 2.00 to map to original image.]",
		);
		const frames = framesFor([
			{ role: "user", content: [text("look"), image] },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: [text("result"), image] }],
			},
		]);
		const rewritten = rewrite(
			[
				{ role: "user", content: [text(memory), text("look"), resized, note] },
				{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: [text("result"), image, text(`\n${account}`)],
						},
						text(memory),
					],
				},
			],
			frames,
		);
		expect(rewritten[0]?.content).toEqual([text("look"), resized, note]);
		expect(rewritten[2]?.content).toEqual([
			{ type: "tool_result", tool_use_id: "t1", content: [text("result"), image] },
		]);
	});

	it("利用者が書いたリマインダー風の文や普通の出力は変えない", () => {
		const canonical = [
			{ role: "user", content: [text("<system-reminder>mine</system-reminder>"), text("inspect")] },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: `file says\n${account}`,
						is_error: false,
					},
					text("<system-reminder>also mine</system-reminder>"),
				],
			},
		];
		const wire = structuredClone(canonical);
		const toolResult = wire[2]?.content[0];
		if (toolResult !== undefined) toolResult["content"] = `file says\n${account}\n${memory}`;
		expect(rewrite(wire, framesFor(canonical))).toEqual(canonical);
		expect(rewrite(structuredClone(canonical), framesFor(canonical))).toEqual(canonical);
	});

	it("落としたリマインダーにあった区切りを正規の末尾へ移す", () => {
		const marker = { type: "ephemeral" };
		const rewritten = rewrite(
			[{ role: "user", content: [text("inspect"), { ...text(memory), cache_control: marker }] }],
			framesFor([{ role: "user", content: [text("inspect")] }]),
		);
		expect(rewritten[0]?.content).toEqual([{ ...text("inspect"), cache_control: marker }]);
	});

	it("luna の履歴と揃わない要求は断る", () => {
		const frames = framesFor([
			{ role: "user", content: [text("inspect")] },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] },
		]);
		expect(() => rewrite([{ role: "user", content: [text("inspect")] }], frames)).toThrow(
			/1 user messages where Pi's history has 2/u,
		);
		expect(() =>
			rewrite(
				[
					{ role: "user", content: [text("inspect")] },
					{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
					{
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "other", content: "result" }],
					},
				],
				frames,
			),
		).toThrow(/lost a tool_result block in user message 1/u);
		expect(() =>
			rewriteInitialRequest(Buffer.from(JSON.stringify({ messages: [] })), frames, undefined),
		).toThrow("Claude Code request is missing its initial user message");
		expect(() =>
			rewriteInitialRequest(Buffer.from(JSON.stringify({ messages: "x" })), frames, undefined),
		).toThrow(/invalid_type/u);
	});

	it("ネイティブの system の履歴を assistant の境界へ差し込む", () => {
		const body = {
			system: [
				{ type: "text", text: "identity", cache_control: { type: "ephemeral", ttl: "1h" } },
				{ type: "text", text: "prompt", cache_control: { type: "ephemeral", ttl: "1h" } },
			],
			messages: [
				{ role: "user", content: [{ type: "text", text: "first" }] },
				{ role: "system", content: [{ type: "text", text: "environment" }] },
				{ role: "assistant", content: [{ type: "text", text: "answer" }] },
				{ role: "user", content: [{ type: "text", text: "second" }] },
				{ role: "system", content: [{ type: "text", text: "token reminder" }] },
			],
		};
		const rewritten = JSON.parse(
			rewriteInitialRequest(
				Buffer.from(JSON.stringify(body)),
				framesFor(body.messages),
				undefined,
				[
					{
						beforeAssistant: 0,
						content: [
							{ type: "tool_addition", tool: { type: "tool_reference", name: "mcp__pi__beta" } },
						],
					},
					{
						beforeAssistant: null,
						content: [
							{ type: "tool_removal", tool: { type: "tool_reference", name: "mcp__pi__alpha" } },
						],
					},
				],
			).toString("utf8"),
		) as { system: Block[]; messages: WireMessage[] };

		expect(rewritten.messages.map((message) => message.role)).toEqual([
			"user",
			"system",
			"system",
			"assistant",
			"user",
			"system",
			"system",
		]);
		expect(blocks(rewritten.messages[2])[0]?.["type"]).toBe("tool_addition");
		expect(blocks(rewritten.messages.at(-1))[0]?.["type"]).toBe("tool_removal");
		expect(rewritten.system[0]?.["cache_control"]).toBeUndefined();
		expect(rewritten.system[1]?.["cache_control"]).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(blocks(rewritten.messages.at(-1)).at(-1)?.["cache_control"]).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
	});

	it("区切り付きの複数ブロックの末尾メッセージでも区切りを1つに保つ（上流 issue #10）", () => {
		const marker = { type: "ephemeral", ttl: "1h" };
		const body = {
			system: [
				{ type: "text", text: "billing" },
				{ type: "text", text: "identity", cache_control: marker },
				{ type: "text", text: "prompt", cache_control: marker },
			],
			tools: [{ name: "mcp__pi__bash", input_schema: { type: "object" }, cache_control: marker }],
			messages: [
				{ role: "user", content: [{ type: "text", text: "run it" }] },
				{ role: "system", content: "environment" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "t1", name: "mcp__pi__bash", input: {} }],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "hi" }] },
				{
					role: "system",
					content: [
						{ type: "text", text: "date reminder", cache_control: marker },
						{ type: "text", text: "parallel tool nudge" },
					],
				},
			],
		};
		const rewritten: unknown = JSON.parse(
			rewriteInitialRequest(
				Buffer.from(JSON.stringify(body)),
				framesFor(body.messages),
				[
					{
						role: "system",
						content: [{ type: "text", text: "environment", cache_control: marker }],
					},
				],
				[],
			).toString("utf8"),
		);
		const count = (value: unknown): number => {
			if (Array.isArray(value)) return value.reduce((sum: number, child) => sum + count(child), 0);
			if (typeof value !== "object" || value == null) return 0;
			return Object.entries(value).reduce(
				(sum, [key, child]) => sum + (key === "cache_control" ? 1 : count(child)),
				0,
			);
		};
		expect(count(rewritten)).toBeLessThanOrEqual(4);
		const final = blocks((rewritten as { messages: WireMessage[] }).messages.at(-1));
		expect(final[0]?.["cache_control"]).toBeUndefined();
		expect(final.at(-1)?.["cache_control"]).toEqual(marker);
	});
});

const userFrame = (value: string): NativeFrame => ({
	type: "user",
	message: { role: "user", content: [{ type: "text", text: value }] },
});

describe("runClaudeRequest の環境", () => {
	it.each([
		"ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_BASE_URL",
		"ANTHROPIC_FOUNDRY_API_KEY",
		"CLAUDE_CODE_USE_BEDROCK",
		"CLAUDE_CODE_USE_VERTEX",
		"CLAUDE_CODE_USE_FOUNDRY",
	])("%s による認証や経路の差し替えを断る", async (key) => {
		await expect(
			runClaudeRequest({
				model: "claude-sonnet-5-5",
				frames: [],
				systemPrompt: "",
				manifest: [],
				extraBody: {},
				env: { [key]: "1", ANTHROPIC_API_KEY: "test-dummy" },
			}),
		).rejects.toThrow(new RegExp(`refuses conflicting auth/backend overrides:.*${key}`, "u"));
	});

	it("値が 0 や false の切り替えは差し替えとみなさない", async () => {
		await expect(
			runClaudeRequest({
				model: "claude-sonnet-5-5",
				frames: [userFrame("hi")],
				systemPrompt: "",
				manifest: [],
				extraBody: {},
				env: { CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "false", PATH: "" },
			}),
		).rejects.toThrow("Claude Code is not installed. Install it so that `claude` is on PATH.");
	});
});

describe("getClaudeStatus", () => {
	it("PATH に claude が無ければ未インストールと報告する", async () => {
		await expect(getClaudeStatus({ PATH: "" })).resolves.toEqual({
			available: false,
			loggedIn: false,
			subscription: false,
			detail: "Claude Code is not installed. Install it so that `claude` is on PATH.",
		});
	});

	it("サブスクのログインを読み取る", async () => {
		const fake = await fakeClaude(AUTH_STATUS_OK);
		await expect(getClaudeStatus(fake.env)).resolves.toMatchObject({
			available: true,
			loggedIn: true,
			subscription: true,
			plan: "max",
			authMethod: "claude.ai",
		});
	});

	it("ログアウトの JSON は終了コードによらずログアウトとして扱う", async () => {
		const fake = await fakeClaude(
			`console.log("warning: update available\\n" + JSON.stringify({loggedIn: false})); process.exit(1);`,
		);
		const status = await getClaudeStatus(fake.env);
		expect(status).toMatchObject({ available: true, loggedIn: false, subscription: false });
		expect(status.diagnostic).toBeUndefined();
		expect(status.detail).toBe(
			"Claude Code is installed but not logged in. Run `claude auth login` and try again.",
		);
	});

	it("JSON でない出力はログアウトに見せかけず診断として報告する", async () => {
		const fake = await fakeClaude(`console.error("boom"); process.exit(3);`);
		const status = await getClaudeStatus(fake.env);
		expect(status).toMatchObject({ available: true, loggedIn: false, diagnostic: true });
		expect(status.detail).toBe(
			"Claude Code status check failed (exit 3): unexpected auth status output: boom",
		);
	});
});

const STREAMING_FAKE = `import readline from "node:readline";
import {appendFileSync, readFileSync} from "node:fs";
if ("ANTHROPIC_API_KEY" in process.env) throw new Error("API key leaked to Claude child");
${AUTH_STATUS_OK}
if (process.argv.includes("--system-prompt-file")) {
  for (const name of ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING"]) {
    if (process.env[name] !== "1") throw new Error(\`worker privacy flag missing: \${name}\`);
  }
}
if (process.cwd() !== process.env.EXPECTED_CWD) throw new Error(\`wrong cwd: \${process.cwd()}\`);
if (process.env.CLAUDE_CODE_ENTRYPOINT !== "pi-agent") throw new Error("wrong entrypoint");
if (process.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS !== "1") throw new Error("file mentions enabled");
if (process.env.PROCESS_LOG) appendFileSync(process.env.PROCESS_LOG, \`\${process.pid}\\n\`);
const mcpIndex = process.argv.indexOf("--mcp-config");
const mcp = JSON.parse(process.argv[mcpIndex + 1]).mcpServers.pi;
if (mcp.command !== process.execPath || !readFileSync(mcp.args[0], "utf8").includes("tools/list")) {
  throw new Error("inert MCP server missing");
}
const systemIndex = process.argv.indexOf("--system-prompt-file");
if (readFileSync(process.argv[systemIndex + 1], "utf8") !== process.env.EXPECTED_SYSTEM_PROMPT) {
  throw new Error("wrong system prompt");
}
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
let queryCount = 0;
const echoUuid = frame => frame.uuid ? {user_message_uuids: [frame.uuid]} : {};
const strayResult = {type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0};
console.log(JSON.stringify({type: "system", subtype: "init"}));
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.shouldQuery === false) {
    console.log(JSON.stringify({type: "result", num_turns: 0, ...echoUuid(frame)}));
    continue;
  }
  if (frame.type !== "user") continue;
  queryCount += 1;
  const requestedTool = frame.message?.content?.some?.(block => block.type === "text" && block.text === "call-tool");
  const text = queryCount === 1 ? "ok" : \`ok\${queryCount}\`;
  const id = queryCount === 1 ? "m_fake" : \`m_fake_\${queryCount}\`;
  const usage = {input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
  if (requestedTool) {
    const content = [{type: "tool_use", id: "tool_fake", name: "mcp__pi__echo", input: {value: "test"}}];
    console.log(JSON.stringify({type: "stream_event", event: {type: "message_stop"}}));
    console.log(JSON.stringify({type: "assistant", message: {id, role: "assistant", content, stop_reason: "tool_use", usage}}));
    console.log(JSON.stringify({type: "user", message: {role: "user", content: [{type: "tool_result", tool_use_id: "tool_fake"}]}}));
    console.log(JSON.stringify({type: "result", subtype: "error_max_turns", is_error: true, usage, ...echoUuid(frame)}));
    continue;
  }
  if (process.env.NATIVE_ERROR) {
    const content = [{type: "text", text: "Usage limit"}];
    console.log(JSON.stringify({type: "assistant", error: "rate_limit", message: {id, role: "assistant", content, usage}}));
    console.log(JSON.stringify({type: "result", subtype: "success", is_error: true, usage, ...echoUuid(frame)}));
    continue;
  }
  if (process.env.HANG) continue;
  if (process.env.GARBAGE) {
    console.log("not json");
    continue;
  }
  const events = [
    {type: "message_start", message: {id, role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
    {type: "content_block_delta", index: 0, delta: {type: "text_delta", text}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "end_turn"}, usage},
    {type: "message_stop"}
  ];
  for (const event of events) console.log(JSON.stringify({type: "stream_event", event}));
  console.log(JSON.stringify({type: "assistant", message: {id, role: "assistant", content: [{type: "text", text}], stop_reason: "end_turn", usage}}));
  console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage, ...echoUuid(frame)}));
  if (process.env.STALE_RESULT === "foreign") console.log(JSON.stringify({...strayResult, user_message_uuids: ["other"]}));
  if (process.env.STALE_RESULT === "bare") console.log(JSON.stringify(strayResult));
}
`;

describe("runClaudeRequest", () => {
	it("stream-json の Claude Code で1ターンを流し、温まったプロセスを使い回す", async () => {
		const fake = await fakeClaude(STREAMING_FAKE);
		const events: string[] = [];
		const originalApiKey = process.env["ANTHROPIC_API_KEY"];
		try {
			process.env["ANTHROPIC_API_KEY"] = "test-dummy";
			const env = {
				...fake.env,
				EXPECTED_CWD: fake.root,
				EXPECTED_SYSTEM_PROMPT: "system",
			};

			const result = await runClaudeRequest({
				model: "claude-sonnet-5-5",
				cwd: fake.root,
				frames: [
					{ ...userFrame("old"), shouldQuery: false },
					{
						type: "assistant",
						message: { role: "assistant", content: [{ type: "text", text: "old reply" }] },
					},
					userFrame("new"),
				],
				systemPrompt: "system",
				manifest: [],
				extraBody: { tools: [] },
				env,
				timeoutMs: 5000,
				onEvent: (event) => events.push(event.type),
			});
			expect(result.message.id).toBe("m_fake");
			expect(result.message.stop_reason).toBe("end_turn");
			expect(result.usage.input_tokens).toBe(3);
			expect(result.relay.upstreamRequests).toBe(0);
			expect(events.at(-1)).toBe("message_stop");

			const processLog = join(fake.root, "processes.log");
			const processCount = async () =>
				(await readFile(processLog, "utf8")).trim().split("\n").length;
			const common = {
				model: "claude-sonnet-5-5",
				cwd: fake.root,
				systemPrompt: "system",
				manifest: [],
				extraBody: { tools: [] },
				env: { ...env, PROCESS_LOG: processLog, ANTHROPIC_API_KEY: "test-explicit-dummy" },
				timeoutMs: 5000,
			};
			const first = await runClaudeRequest({
				...common,
				sessionId: "stable-session",
				frames: [userFrame("one")],
			});
			const second = await runClaudeRequest({
				...common,
				sessionId: "stable-session",
				frames: [
					{ ...userFrame("one"), shouldQuery: false },
					{ type: "assistant", message: { role: "assistant", content: first.message.content } },
					userFrame("two"),
				],
			});
			expect(second.message.id).toBe("m_fake_2");
			expect(await processCount()).toBe(1);
			expect(cachedClaudeProcessCount()).toBe(1);

			// 分岐したら古い隠れた状態を当てにせず、温まったプロセスを入れ替える。
			const branched = await runClaudeRequest({
				...common,
				sessionId: "stable-session",
				frames: [userFrame("branch")],
			});
			expect(branched.message.id).toBe("m_fake");
			expect(await processCount()).toBe(2);

			// 残すワーカーは2つまで。新しいセッションが来たら一番古い空きを追い出す。
			for (const sessionId of ["second-session", "third-session"]) {
				await runClaudeRequest({ ...common, sessionId, frames: [userFrame(sessionId)] });
			}
			expect(cachedClaudeProcessCount()).toBe(2);
			expect(await processCount()).toBe(4);

			// ツール呼び出しの後は inert MCP の拒否が隠れた履歴に残るため、プロセスを残さず次は作り直す。
			const toolCommon = {
				...common,
				manifest: [
					{
						name: "echo",
						description: "Echo a value",
						inputSchema: { type: "object", properties: { value: { type: "string" } } },
					},
				],
				extraBody: {
					tools: [
						{
							name: "mcp__pi__echo",
							description: "Echo a value",
							input_schema: { type: "object", properties: { value: { type: "string" } } },
						},
					],
				},
			};
			const toolCall = await runClaudeRequest({
				...toolCommon,
				sessionId: "tool-session",
				frames: [userFrame("call-tool")],
			});
			expect(toolCall.message.stop_reason).toBe("tool_use");
			expect(cachedClaudeProcessCount()).toBe(1);
			const afterTool = await runClaudeRequest({
				...toolCommon,
				sessionId: "tool-session",
				frames: [
					{ ...userFrame("call-tool"), shouldQuery: false },
					{ type: "assistant", message: { role: "assistant", content: toolCall.message.content } },
					{
						type: "user",
						message: {
							role: "user",
							content: [{ type: "tool_result", tool_use_id: "tool_fake", content: "echoed" }],
						},
					},
				],
			});
			expect(afterTool.message.id).toBe("m_fake");
			expect(await processCount()).toBe(6);
			expect(process.env["ANTHROPIC_API_KEY"]).toBe("test-dummy");

			const warmTurns = async (sessionId: string, extra: Record<string, string>) => {
				const warm = { ...common, env: { ...common.env, ...extra }, sessionId };
				const one = await runClaudeRequest({ ...warm, frames: [userFrame("one")] });
				return await runClaudeRequest({
					...warm,
					frames: [
						{ ...userFrame("one"), shouldQuery: false },
						{ type: "assistant", message: { role: "assistant", content: one.message.content } },
						userFrame("two"),
					],
				});
			};
			// 他の user メッセージ宛ての遅れた result で次のターンを終わらせない。
			const foreign = await warmTurns("foreign-session", { STALE_RESULT: "foreign" });
			expect(foreign.message.id).toBe("m_fake_2");
			expect(await processCount()).toBe(7);

			// uuid の無い迷子の result は出力前に温まったターンを失敗させるので、新しいプロセスで一度やり直す。
			const bare = await warmTurns("bare-session", { STALE_RESULT: "bare" });
			expect(bare.message.id).toBe("m_fake");
			expect(await processCount()).toBe(9);

			// エラーの assistant は不完全な応答ではなく、その本文を報告する。
			await expect(
				runClaudeRequest({
					...common,
					env: { ...common.env, NATIVE_ERROR: "1" },
					frames: [userFrame("one")],
				}),
			).rejects.toThrow(/Claude Code API error: Usage limit/u);
		} finally {
			if (originalApiKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
			else process.env["ANTHROPIC_API_KEY"] = originalApiKey;
		}
	}, 30_000);

	it("予備を控えるセッションは起動済みのプロセスで受け、使ったら捨てて次の予備を起動する", async () => {
		const fake = await fakeClaude(STREAMING_FAKE);
		const processLog = join(fake.root, "processes.log");
		const processCount = async () => (await readFile(processLog, "utf8")).trim().split("\n").length;
		const common = {
			model: "claude-haiku-5-5",
			cwd: fake.root,
			systemPrompt: "system",
			manifest: [],
			extraBody: { tools: [] },
			env: {
				...fake.env,
				EXPECTED_CWD: fake.root,
				EXPECTED_SYSTEM_PROMPT: "system",
				PROCESS_LOG: processLog,
			},
			timeoutMs: 5000,
			sessionId: "voice-front",
		};
		const release = keepSpareClaudeProcess("voice-front");
		try {
			// 最初の要求には予備がないので自分で起動し、同時に次の予備を起動する。
			const first = await runClaudeRequest({ ...common, frames: [userFrame("one")] });
			expect(first.message.id).toBe("m_fake");
			await vi.waitFor(async () => {
				expect(await processCount()).toBe(2);
			});

			// 履歴が変わっても予備で受ける。新しく起動するのは次の予備の1つだけ。
			const second = await runClaudeRequest({ ...common, frames: [userFrame("two")] });
			expect(second.message.id).toBe("m_fake");
			await vi.waitFor(async () => {
				expect(await processCount()).toBe(3);
			});
			expect(cachedClaudeProcessCount()).toBe(0);

			// 起動の条件が違えば予備を捨てて起動し直す。
			const changed = await runClaudeRequest({
				...common,
				systemPrompt: "other",
				env: { ...common.env, EXPECTED_SYSTEM_PROMPT: "other" },
				frames: [userFrame("three")],
			});
			expect(changed.message.id).toBe("m_fake");
			await vi.waitFor(async () => {
				expect(await processCount()).toBe(5);
			});
		} finally {
			await release();
		}

		// 解放した後は予備を起動しない。
		await runClaudeRequest({ ...common, sessionId: undefined, frames: [userFrame("four")] });
		expect(await processCount()).toBe(6);
	}, 30_000);

	it("応答が時間内に来なければタイムアウトで失敗し、プロセスを残さない", async () => {
		const fake = await fakeClaude(STREAMING_FAKE);
		await expect(
			runClaudeRequest({
				model: "claude-sonnet-5-5",
				cwd: fake.root,
				frames: [userFrame("hi")],
				systemPrompt: "system",
				manifest: [],
				extraBody: { tools: [] },
				env: { ...fake.env, EXPECTED_CWD: fake.root, EXPECTED_SYSTEM_PROMPT: "system", HANG: "1" },
				sessionId: "hang",
				timeoutMs: 300,
			}),
		).rejects.toThrow("Claude Code stream timed out");
		expect(cachedClaudeProcessCount()).toBe(0);
	}, 10_000);

	it("stream-json として読めない出力は不正な応答として失敗する", async () => {
		const fake = await fakeClaude(STREAMING_FAKE);
		await expect(
			runClaudeRequest({
				model: "claude-sonnet-5-5",
				cwd: fake.root,
				frames: [userFrame("hi")],
				systemPrompt: "system",
				manifest: [],
				extraBody: { tools: [] },
				env: {
					...fake.env,
					EXPECTED_CWD: fake.root,
					EXPECTED_SYSTEM_PROMPT: "system",
					GARBAGE: "1",
				},
				timeoutMs: 5000,
			}),
		).rejects.toThrow("Invalid Claude Code stream-json output: not json");
	}, 10_000);

	it("ログインしていなければ起動前に失敗する", async () => {
		const fake = await fakeClaude(
			`console.log(JSON.stringify({loggedIn: false})); process.exit(1);`,
		);
		await expect(
			runClaudeRequest({
				model: "claude-sonnet-5-5",
				frames: [userFrame("hi")],
				systemPrompt: "system",
				manifest: [],
				extraBody: {},
				env: fake.env,
			}),
		).rejects.toThrow(
			"Claude Code is installed but not logged in. Run `claude auth login` and try again.",
		);
	});
});

// 本物と同じく、中継された応答を読んでから一度だけ自前で再試行する偽の Claude Code で1ターンを流す。
async function failingUpstreamTurn(
	upstream?: http.RequestListener,
): Promise<{ message: string; retryable: boolean }> {
	let server: http.Server | undefined;
	let port: number;
	const listen = async (target: http.Server) => {
		await new Promise<void>((resolve) => {
			target.listen(0, "127.0.0.1", resolve);
		});
		const address = target.address();
		if (address == null || typeof address === "string") throw new Error("missing address");
		return address.port;
	};
	if (upstream) {
		server = http.createServer(upstream);
		port = await listen(server);
	} else {
		// 空いたポートを取ってから閉じ、接続を拒ませる。
		const probe = http.createServer();
		port = await listen(probe);
		await new Promise<void>((resolve) => {
			probe.close(() => {
				resolve();
			});
		});
	}

	const fake = await fakeClaude(`import readline from "node:readline";
${AUTH_STATUS_OK}
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(\`\${process.env.ANTHROPIC_BASE_URL}/v1/messages\`, {
        method: "POST",
        body: JSON.stringify({messages: [frame.message]}),
      });
      await response.text();
    } catch {}
  }
  console.log(JSON.stringify({type: "result", subtype: "error_during_execution", is_error: true}));
}
`);

	try {
		const error = await runClaudeRequest({
			model: "claude-sonnet-5-5",
			cwd: fake.root,
			frames: [userFrame("hi")],
			systemPrompt: "system",
			manifest: [],
			extraBody: { tools: [] },
			env: fake.env,
			upstreamUrl: `http://127.0.0.1:${port}`,
			timeoutMs: 5000,
		}).then(
			() => {
				throw new Error("expected the upstream failure to fail the turn");
			},
			(failure: unknown) => (failure instanceof Error ? failure : new Error(String(failure))),
		);
		const failed = fauxAssistantMessage([], { stopReason: "error", errorMessage: error.message });
		return { message: error.message, retryable: isRetryableAssistantError(failed) };
	} finally {
		const target = server;
		if (target) {
			await new Promise<void>((resolve) => {
				target.close(() => {
					resolve();
				});
			});
		}
	}
}

async function drain(request: http.IncomingMessage): Promise<void> {
	for await (const _chunk of request) {
		// 本文を読み切ってから応答する。
	}
}

describe("上流の失敗", () => {
	it("途中で切れたストリームは再試行できるエラーにする", async () => {
		const { message, retryable } = await failingUpstreamTurn((request, response) => {
			void drain(request).then(() => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				const usage = { input_tokens: 2, output_tokens: 0 };
				response.write(
					`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } })}\n\n`,
				);
				setTimeout(() => response.socket?.destroy(), 20);
			});
		});
		expect(message).toMatch(/status 200, capture incomplete/u);
		expect(message).toMatch(/native retries denied 1/u);
		expect(retryable).toBe(true);
	}, 10_000);

	it("応答前に切れた接続は再試行できるエラーにする", async () => {
		const hangUp = await failingUpstreamTurn((request) => {
			void drain(request).then(() => request.socket.destroy());
		});
		expect(hangUp.message).toMatch(/connection lost before a response \(status unknown/u);
		expect(hangUp.message).toMatch(/relay failure Error: socket hang up/u);
		expect(hangUp.retryable).toBe(true);

		const refused = await failingUpstreamTurn();
		expect(refused.message).toMatch(/connection lost before a response \(status unknown/u);
		expect(refused.message).toMatch(/ECONNREFUSED/u);
		expect(refused.retryable).toBe(true);
	}, 10_000);

	it("5xx は再試行でき、4xx は再試行しない", async () => {
		const overloaded = await failingUpstreamTurn((request, response) => {
			void drain(request).then(() => response.writeHead(529).end());
		});
		expect(overloaded.message).toMatch(/upstream server error \(status 529/u);
		expect(overloaded.retryable).toBe(true);

		const invalid = await failingUpstreamTurn((request, response) => {
			void drain(request).then(() =>
				response.writeHead(400, { "content-type": "application/json" }).end(
					JSON.stringify({
						type: "error",
						error: { type: "invalid_request_error", message: "bad request" },
					}),
				),
			);
		});
		expect(invalid.message).toMatch(
			/Incomplete Claude Code upstream response \(status 400.*upstream said: bad request/u,
		);
		expect(invalid.retryable).toBe(false);
	}, 10_000);
});
