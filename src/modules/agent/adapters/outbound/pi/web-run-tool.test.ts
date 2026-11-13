import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatGptBackend } from "./chatgpt-backend";
import { createWebRunTool } from "./web-run-tool";

const fetchMock = vi.fn<typeof fetch>();
const ACCESS_TOKEN = `header.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
).toString("base64")}.signature`;

function hangUntilAborted(
	_input: Parameters<typeof fetch>[0],
	init?: RequestInit,
): Promise<Response> {
	return new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => {
			const reason: unknown = init.signal?.reason;
			reject(reason instanceof Error ? reason : new Error(String(reason)));
		});
	});
}

function requestBody(index: number): unknown {
	const body = fetchMock.mock.calls[index]?.[1]?.body;
	if (typeof body !== "string") throw new TypeError("request body is not a string");
	const parsed: unknown = JSON.parse(body);
	return parsed;
}

function user(content: UserMessage["content"]): Message {
	return { role: "user", content, timestamp: 0 };
}

function assistant(content: AssistantMessage["content"]): Message {
	return {
		role: "assistant",
		content,
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-6.1-sol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("web_run", () => {
	let conversation: Message[];
	const signal = new AbortController().signal;
	const query = { search_query: [{ q: "x" }] };

	async function createTool(options: { loggedIn?: boolean; timeoutMs?: number } = {}) {
		const credentials = new InMemoryCredentialStore();
		if (options.loggedIn ?? true) {
			await credentials.modify("openai-codex", async () => ({
				type: "oauth",
				access: ACCESS_TOKEN,
				refresh: "refresh",
				expires: Date.now() + 3_600_000,
				accountId: "account-1",
			}));
		}
		const models = createModels({ credentials });
		models.setProvider(openaiCodexProvider());
		return createWebRunTool({
			backend: new ChatGptBackend({ models, timeoutMs: options.timeoutMs ?? 1000 }),
			sessionId: "session-1",
			model: "gpt-6.1-sol",
			maxOutputTokens: 10_000,
			conversation: () => conversation,
		});
	}

	beforeEach(() => {
		conversation = [];
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("Codexのweb.runと同じコマンド体系を公開する", async () => {
		const tool = await createTool();

		expect(tool.name).toBe("web_run");
		expect(tool.description).toContain('{"search_query": [{"q": ""}]}');
		expect(tool.parameters).toMatchObject({
			type: "object",
			properties: {
				search_query: { type: "array" },
				image_query: { type: "array" },
				open: { type: "array" },
				click: { type: "array" },
				find: { type: "array" },
				screenshot: { type: "array" },
				finance: { type: "array" },
				weather: { type: "array" },
				sports: { type: "array" },
				time: { type: "array" },
				response_length: { enum: ["short", "medium", "long"] },
			},
		});
		expect(tool.parameters).not.toHaveProperty("properties.literature_search_query");
	});

	it("セッションID・モデル・直近の会話・コマンドを送り、outputを返す", async () => {
		conversation = [
			user("old user"),
			assistant([{ type: "text", text: "old assistant" }]),
			user([
				{ type: "text", text: "previous user" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			]),
			assistant([
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: "previous assistant" },
				{ type: "toolCall", id: "call-1", name: "web_run", arguments: {} },
			]),
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "web_run",
				content: [{ type: "text", text: "tool output" }],
				isError: false,
				timestamp: 0,
			},
			user("current user"),
			assistant([{ type: "text", text: "current commentary" }]),
		];
		fetchMock.mockResolvedValueOnce(
			Response.json({ encrypted_output: "x", output: "search result", results: [] }),
		);

		await expect(
			(await createTool()).execute(
				{ search_query: [{ q: "luna", recency: 7 }], response_length: "medium", unknown: 1 },
				signal,
			),
		).resolves.toEqual({ text: "search result", images: [], isError: false });

		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
		expect(requestBody(0)).toEqual({
			id: "session-1",
			model: "gpt-6.1-sol",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "previous user" }],
				},
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "previous assistant" }],
				},
				{ type: "message", role: "user", content: [{ type: "input_text", text: "current user" }] },
			],
			commands: { search_query: [{ q: "luna", recency: 7 }], response_length: "medium" },
			settings: { allowed_callers: ["direct"], external_web_access: true },
			max_output_tokens: 10_000,
		});
	});

	it("アシスタントの文章は合計1kトークンまでに中央を省いて縮め、会話がなければinputを省く", async () => {
		conversation = [
			user("previous user"),
			assistant([{ type: "text", text: `${"a".repeat(3000)}${"b".repeat(3000)}` }]),
			assistant([{ type: "text", text: "after budget" }]),
			user("current user"),
		];
		fetchMock
			.mockResolvedValueOnce(Response.json({ output: "first" }))
			.mockResolvedValueOnce(Response.json({ output: "second" }));
		const tool = await createTool();

		await tool.execute({ open: [{ ref_id: "turn0search0" }] }, signal);
		conversation = [];
		await tool.execute({ time: [{ utc_offset: "+09:00" }] }, signal);

		expect(requestBody(0)).toMatchObject({
			input: [
				{ role: "user", content: [{ type: "input_text", text: "previous user" }] },
				{
					role: "assistant",
					content: [
						{
							type: "output_text",
							text: `${"a".repeat(2000)}…500 tokens truncated…${"b".repeat(2000)}`,
						},
					],
				},
				{ role: "user", content: [{ type: "input_text", text: "current user" }] },
			],
		});
		expect(requestBody(1)).not.toHaveProperty("input");
		expect(requestBody(1)).toMatchObject({ commands: { time: [{ utc_offset: "+09:00" }] } });
	});

	it("不正な引数とliterature_search_queryは送らずにエラーを返す", async () => {
		const tool = await createTool();

		await expect(tool.execute({ click: [{ ref_id: "x", id: -1 }] }, signal)).resolves.toMatchObject(
			{ isError: true },
		);
		await expect(
			tool.execute({ literature_search_query: [{ q: "papers" }] }, signal),
		).resolves.toEqual({
			text: "literature_search_query is unavailable for this model",
			images: [],
			isError: true,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("HTTPエラーは1024バイトまでに切り詰めてツールのエラーとして返す", async () => {
		fetchMock.mockResolvedValueOnce(new Response("🦀".repeat(512), { status: 500 }));

		const result = await (await createTool()).execute(query, signal);

		expect(result.isError).toBe(true);
		expect(result.text).toContain("500");
		expect(result.text.endsWith("… [truncated]")).toBe(true);
		expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1024);
	});

	it("タイムアウト・不正な応答・資格情報なしをツールのエラーとして返す", async () => {
		fetchMock
			.mockImplementationOnce(hangUntilAborted)
			.mockResolvedValueOnce(Response.json({ results: [] }));

		const timedOut = await (await createTool({ timeoutMs: 20 })).execute(query, signal);
		const invalid = await (await createTool()).execute(query, signal);
		const loggedOut = await (await createTool({ loggedIn: false })).execute(query, signal);

		expect(timedOut).toMatchObject({ isError: true, text: expect.stringContaining("timed out") });
		expect(invalid).toMatchObject({ isError: true, text: expect.stringContaining("unexpected") });
		expect(loggedOut).toMatchObject({ isError: true, text: "ChatGPT login is required" });
	});

	it("呼び出し元の中断は例外としてそのまま返す", async () => {
		const controller = new AbortController();
		fetchMock.mockImplementationOnce((input, init) => {
			const pending = hangUntilAborted(input, init);
			controller.abort(new Error("stopped"));
			return pending;
		});

		await expect((await createTool()).execute(query, controller.signal)).rejects.toThrow("stopped");
	});
});
