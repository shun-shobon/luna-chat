import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type {
	FauxModelDefinition,
	FauxResponseStep,
	Message,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { formatLocalDate } from "../../../../../shared/local-date";
import { createRecordingLogger } from "../../../../observability/testing/recording-logger";
import type { RecordingLogger } from "../../../../observability/testing/recording-logger";
import type {
	AgentSession,
	AgentSessionSpec,
	AgentTool,
	AgentToolResult,
} from "../../../ports/outbound/agent-session-port";
import { PiAgentRuntime } from "./pi-agent-runtime";
import type { HarnessToolContext } from "./pi-agent-runtime";
import type { HarnessToolSet } from "./pi-agent-session";
import { SessionBusyError, SessionClosedError } from "./pi-agent-session";

const NOW = new Date("2026-11-14T12:00:00+09:00");
const temporaryDirectories: string[] = [];
const openedSessions: AgentSession[] = [];

afterEach(async () => {
	// 記録の書き込みが残ったまま消すと ENOTEMPTY になるため、先に閉じて書き込みを待つ。
	await Promise.all(openedSessions.splice(0).map((session) => session.close()));
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

type Setup = Readonly<{
	runtime: PiAgentRuntime;
	faux: ReturnType<typeof fauxProvider>;
	transcriptDir: string;
	scratchRoot: string;
	harnessContexts: HarnessToolContext[];
	harnessDispose: ReturnType<typeof vi.fn>;
	backgroundCount: { value: number };
	hasCredentials: { value: boolean };
	logger: RecordingLogger;
}>;

async function setup(
	options: {
		models?: FauxModelDefinition[];
		retryDelaysMs?: number[];
		reserveTokens?: number;
		keepRecentTokens?: number;
		harnessTools?: HarnessToolSet["tools"];
	} = {},
): Promise<Setup> {
	const faux = fauxProvider({
		models: options.models ?? [
			{ id: "faux-1", name: "Faux One", reasoning: true },
			{ id: "faux-2", name: "Faux Two" },
		],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const transcriptDir = await mkdtemp(path.join(tmpdir(), "pi-runtime-"));
	temporaryDirectories.push(transcriptDir);
	const harnessDispose = vi.fn(async () => undefined);
	const scratchRoot = path.join(transcriptDir, "scratch");
	const harnessContexts: HarnessToolContext[] = [];
	const backgroundCount = { value: 0 };
	const harnessBackground = {
		count: () => backgroundCount.value,
		stopAll: async () => {
			backgroundCount.value = 0;
			harnessContexts.at(-1)?.background.stopped();
		},
	};
	const hasCredentials = { value: true };
	const logger = createRecordingLogger();
	const runtime = new PiAgentRuntime({
		models,
		transcriptDir,
		scratchRoot,
		retryDelaysMs: options.retryDelaysMs ?? [1, 1],
		requestTimeoutMs: 60_000,
		compaction: {
			model: { provider: "faux", model: "faux-1", thinking: "off" },
			reserveTokens: options.reserveTokens ?? 16_384,
			keepRecentTokens: options.keepRecentTokens ?? 20_000,
		},
		createHarnessTools: (_spec, context) => {
			harnessContexts.push(context);
			return {
				tools: options.harnessTools ?? [],
				background: harnessBackground,
				dispose: harnessDispose,
			};
		},
		hasCredentials: () => hasCredentials.value,
		logger,
		now: () => NOW,
	});
	const open = runtime.open.bind(runtime);
	runtime.open = (sessionSpec) => {
		const session = open(sessionSpec);
		openedSessions.push(session);
		return session;
	};
	return {
		runtime,
		faux,
		transcriptDir,
		scratchRoot,
		harnessContexts,
		harnessDispose,
		backgroundCount,
		hasCredentials,
		logger,
	};
}

function spec(overrides: Partial<AgentSessionSpec> = {}): AgentSessionSpec {
	return {
		kind: "conversation",
		label: "テスト会話",
		cwd: "/workspace",
		systemPrompt: "あなたはルナです。",
		model: { provider: "faux", model: "faux-1", thinking: "off" },
		tools: [],
		harnessTools: [],
		...overrides,
	};
}

function tool(name: string, execute: AgentTool["execute"]): AgentTool {
	return {
		name,
		description: `${name} tool`,
		parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
		execute,
	};
}

function capture(
	requests: { context: TranscriptContext; model: string }[],
	response: Parameters<typeof fauxAssistantMessage>[0],
): FauxResponseStep {
	return (context, _options, _state, model) => {
		requests.push({ context, model: model.id });
		return fauxAssistantMessage(response);
	};
}

function errorStep(
	errorMessage: string,
	react?: (options: SimpleStreamOptions | undefined) => Promise<void>,
): FauxResponseStep {
	return async (_context, options) => {
		await react?.(options);
		return fauxAssistantMessage([], { stopReason: "error", errorMessage });
	};
}

function texts(messages: readonly Message[], role: Message["role"]): string[] {
	return messages.flatMap((message) => {
		if (message.role !== role || message.role === "assistant") {
			return [];
		}
		const content = message.content;
		if (typeof content === "string") {
			return [content];
		}
		return content.flatMap((block) => (block.type === "text" ? [block.text] : []));
	});
}

function input(text: string, kind = "discord_message") {
	return { kind, text };
}

function toolResults(messages: readonly Message[]) {
	return messages.flatMap((message) => (message.role === "toolResult" ? [message] : []));
}

async function waitForPhase(session: AgentSession, phase: string): Promise<void> {
	await vi.waitFor(
		() => {
			expect(session.status().phase).toBe(phase);
		},
		{ interval: 1 },
	);
}

const transcriptLineSchema = z.looseObject({ type: z.string() });

async function readTranscript(transcriptDir: string, sessionId: string) {
	const raw = await readFile(
		path.join(transcriptDir, formatLocalDate(NOW), `${sessionId}.jsonl`),
		"utf8",
	);
	return raw
		.trim()
		.split("\n")
		.map((line) => transcriptLineSchema.parse(JSON.parse(line)));
}

describe("PiAgentRuntime の実行", () => {
	it("最終 assistant の本文を返し、入力を luna_input の user 文にして送る", async () => {
		const { runtime, faux } = await setup();
		const requests: { context: TranscriptContext; model: string }[] = [];
		faux.setResponses([capture(requests, "こんにちは")]);
		const session = runtime.open(spec());

		const result = await session.run([input("やあ"), input("起きて", "wake")]);

		expect(result).toEqual({ status: "completed", finalText: "こんにちは" });
		expect(texts(requests[0]?.context.messages ?? [], "user")).toEqual([
			'<luna_input kind="discord_message">\nやあ\n</luna_input>',
			'<luna_input kind="wake">\n起きて\n</luna_input>',
		]);
		expect(session.status().phase).toBe("idle");
	});

	it("本文がなければ finalText を null にする", async () => {
		const { runtime, faux } = await setup();
		faux.setResponses([fauxAssistantMessage([])]);

		const result = await runtime.open(spec()).run([input("やあ")]);

		expect(result).toEqual({ status: "completed", finalText: null });
	});

	it("実行中の run は例外にする", async () => {
		const { runtime, faux } = await setup();
		faux.setResponses([fauxAssistantMessage("ok")]);
		const session = runtime.open(spec());

		const first = session.run([input("1")]);
		await expect(session.run([input("2")])).rejects.toBeInstanceOf(SessionBusyError);
		await expect(first).resolves.toEqual({ status: "completed", finalText: "ok" });
	});
});

describe("ツール", () => {
	it("text・images・isError・例外を pi のツール結果に変換する", async () => {
		const { runtime, faux } = await setup();
		const requests: { context: TranscriptContext; model: string }[] = [];
		const received: unknown[] = [];
		const ok = tool("ok_tool", async (args): Promise<AgentToolResult> => {
			received.push(args);
			return { text: "見た", images: [{ data: "aW1n", mimeType: "image/png" }], isError: false };
		});
		const imageOnly = tool("image_tool", async () => ({
			text: "",
			images: [{ data: "aW1n", mimeType: "image/png" }],
			isError: false,
		}));
		const failing = tool("failing_tool", async () => ({ text: "だめ", images: [], isError: true }));
		const throwing = tool("throwing_tool", async () => {
			throw new Error("壊れた");
		});
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("ok_tool", { value: "a" }, { id: "call-1" }),
					fauxToolCall("image_tool", { value: "b" }, { id: "call-2" }),
					fauxToolCall("failing_tool", { value: "c" }, { id: "call-3" }),
					fauxToolCall("throwing_tool", { value: "d" }, { id: "call-4" }),
				],
				{ stopReason: "toolUse" },
			),
			capture(requests, "完了"),
		]);
		const session = runtime.open(spec({ tools: [ok, imageOnly, failing, throwing] }));

		const result = await session.run([input("使って")]);

		expect(result).toEqual({ status: "completed", finalText: "完了" });
		expect(received).toEqual([{ value: "a" }]);
		const results = toolResults(requests[0]?.context.messages ?? []);
		expect(
			results.map(({ toolCallId, content, isError }) => ({ toolCallId, content, isError })),
		).toEqual([
			{
				toolCallId: "call-1",
				content: [
					{ type: "text", text: "見た" },
					{ type: "image", data: "aW1n", mimeType: "image/png" },
				],
				isError: false,
			},
			{
				toolCallId: "call-2",
				content: [{ type: "image", data: "aW1n", mimeType: "image/png" }],
				isError: false,
			},
			{ toolCallId: "call-3", content: [{ type: "text", text: "だめ" }], isError: true },
			{ toolCallId: "call-4", content: [{ type: "text", text: "壊れた" }], isError: true },
		]);
	});

	it("汎用ツールを Luna のツールと一緒に渡し、名前の重複は拒否する", async () => {
		const harnessTool = {
			name: "read",
			label: "read",
			description: "read a file",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [fauxText("中身")], details: undefined }),
		};
		const { runtime, faux, harnessDispose } = await setup({ harnessTools: [harnessTool] });
		const requests: { context: TranscriptContext; model: string }[] = [];
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", {}, { id: "call-1" })], { stopReason: "toolUse" }),
			capture(requests, "読んだ"),
		]);

		await runtime.open(spec({ harnessTools: ["read"] })).run([input("読んで")]);

		expect(toolResults(requests[0]?.context.messages ?? [])[0]?.content).toEqual([
			fauxText("中身"),
		]);
		expect(() =>
			runtime.open(
				spec({ tools: [tool("read", async () => ({ text: "", images: [], isError: false }))] }),
			),
		).toThrow("Duplicated agent tool name: read");
		await vi.waitFor(() => {
			expect(harnessDispose).toHaveBeenCalledTimes(1);
		});
	});
});

describe("バックグラウンド実行", () => {
	const exitInput = input('{"id":"bg-1"}', "background_exit");

	it("実行していない間の完了通知は待ちを true で解き、次の run の入力の前に入れる", async () => {
		const { runtime, faux, harnessContexts, backgroundCount } = await setup();
		const requests: { context: TranscriptContext; model: string }[] = [];
		faux.setResponses([fauxAssistantMessage("始めた"), capture(requests, "見た")]);
		const session = runtime.open(spec());
		await session.run([input("ビルドして")]);
		backgroundCount.value = 1;
		expect(session.hasBackground()).toBe(true);

		const waiting = session.waitForBackground();
		backgroundCount.value = 0;
		harnessContexts[0]?.background.exited(exitInput);

		await expect(waiting).resolves.toBe(true);
		expect(session.hasBackground()).toBe(true);
		await session.run([]);
		expect(texts(requests[0]?.context.messages ?? [], "user").at(-1)).toBe(
			'<luna_input kind="background_exit">\n{"id":"bg-1"}\n</luna_input>',
		);
		expect(session.hasBackground()).toBe(false);
		await expect(session.waitForBackground()).resolves.toBe(false);
		await expect(session.run([])).rejects.toThrow("Agent run requires input");
	});

	it("実行中の完了通知は同じ実行の次のリクエストの前に入る", async () => {
		const { runtime, faux, harnessContexts } = await setup();
		const requests: { context: TranscriptContext; model: string }[] = [];
		const finishing = tool("finish_tool", async () => {
			harnessContexts[0]?.background.exited(exitInput);
			return { text: "ok", images: [], isError: false };
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("finish_tool", { value: "x" })], {
				stopReason: "toolUse",
			}),
			capture(requests, "見た"),
		]);
		const session = runtime.open(spec({ tools: [finishing] }));

		await session.run([input("始めて")]);

		expect(texts(requests[0]?.context.messages ?? [], "user").at(-1)).toBe(
			'<luna_input kind="background_exit">\n{"id":"bg-1"}\n</luna_input>',
		);
		expect(session.hasBackground()).toBe(false);
	});

	it("stopBackground はまだ run に入れていない完了通知も捨てる", async () => {
		const { runtime, harnessContexts } = await setup();
		const session = runtime.open(spec());
		harnessContexts[0]?.background.exited(exitInput);
		expect(session.hasBackground()).toBe(true);

		await session.stopBackground();

		expect(session.hasBackground()).toBe(false);
		await expect(session.waitForBackground()).resolves.toBe(false);
	});

	it("通知なしにすべて止まるか閉じたら待ちを false で解く", async () => {
		const { runtime, backgroundCount } = await setup();
		const stopped = runtime.open(spec());
		backgroundCount.value = 1;
		const waitingStop = stopped.waitForBackground();
		await stopped.stopBackground();
		await expect(waitingStop).resolves.toBe(false);

		const closed = runtime.open(spec());
		backgroundCount.value = 1;
		const waitingClose = closed.waitForBackground();
		await closed.close();
		await expect(waitingClose).resolves.toBe(false);
	});
});

describe("steer", () => {
	it("実行中の steer は次のリクエストの前に入る", async () => {
		const { runtime, faux } = await setup();
		const requests: { context: TranscriptContext; model: string }[] = [];
		const release = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const waiting = tool("wait_tool", async () => {
			started.resolve();
			await release.promise;
			return { text: "待った", images: [], isError: false };
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_tool", { value: "x" })], { stopReason: "toolUse" }),
			capture(requests, "了解"),
		]);
		const session = runtime.open(spec({ tools: [waiting] }));

		const running = session.run([input("始めて")]);
		await started.promise;
		session.steer(input("追加の指示", "steer"));
		release.resolve();

		await expect(running).resolves.toEqual({ status: "completed", finalText: "了解" });
		expect(texts(requests[0]?.context.messages ?? [], "user").at(-1)).toBe(
			'<luna_input kind="steer">\n追加の指示\n</luna_input>',
		);
	});

	it("アイドル時の steer は次の run の入力の後に入る", async () => {
		const { runtime, faux } = await setup();
		const requests: { context: TranscriptContext; model: string }[] = [];
		faux.setResponses([capture(requests, "ok")]);
		const session = runtime.open(spec());

		session.steer(input("後から", "steer"));
		await session.run([input("先に")]);

		expect(texts(requests[0]?.context.messages ?? [], "user")).toEqual([
			'<luna_input kind="discord_message">\n先に\n</luna_input>',
			'<luna_input kind="steer">\n後から\n</luna_input>',
		]);
	});
});

describe("abort", () => {
	it("実行中に abort すると aborted を返す", async () => {
		const { runtime, faux } = await setup();
		const started = Promise.withResolvers<void>();
		const blocking = tool("block_tool", async (_args, signal) => {
			started.resolve();
			await new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => {
					resolve();
				});
			});
			return { text: "止まった", images: [], isError: true };
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("block_tool", { value: "x" })], { stopReason: "toolUse" }),
		]);
		const session = runtime.open(spec({ tools: [blocking] }));

		const running = session.run([input("始めて")]);
		await started.promise;
		await session.abort();

		await expect(running).resolves.toEqual({ status: "aborted" });
		expect(session.status().phase).toBe("idle");
	});

	it("再試行の待機中に abort すると待機を打ち切って aborted を返す", async () => {
		const { runtime, faux } = await setup({ retryDelaysMs: [60_000] });
		faux.setResponses([errorStep("fetch failed")]);
		const session = runtime.open(spec());

		const running = session.run([input("始めて")]);
		await waitForPhase(session, "retry_wait");
		await session.abort();

		await expect(running).resolves.toEqual({ status: "aborted" });
		expect(faux.state.callCount).toBe(1);
	});
});

describe("エラーと再試行", () => {
	it("一時的なエラーは error を外して再開し、待機中の steer も入れる", async () => {
		const { runtime, faux } = await setup({ retryDelaysMs: [300] });
		const requests: { context: TranscriptContext; model: string }[] = [];
		faux.setResponses([
			errorStep("upstream error", async (options) => {
				await options?.onResponse?.({ status: 503, headers: {} }, faux.getModel());
			}),
			capture(requests, "復帰した"),
		]);
		const session = runtime.open(spec());

		const running = session.run([input("始めて")]);
		await waitForPhase(session, "retry_wait");
		session.steer(input("待っている間の指示", "steer"));

		await expect(running).resolves.toEqual({ status: "completed", finalText: "復帰した" });
		expect(session.status().retries).toBe(1);
		expect(texts(requests[0]?.context.messages ?? [], "user")).toEqual([
			'<luna_input kind="discord_message">\n始めて\n</luna_input>',
			'<luna_input kind="steer">\n待っている間の指示\n</luna_input>',
		]);
	});

	it("待機時間の列を使い切ったら transient_exhausted を返す", async () => {
		const { runtime, faux } = await setup({ retryDelaysMs: [1, 1] });
		faux.setResponses([
			errorStep("fetch failed"),
			errorStep("socket hang up"),
			errorStep("fetch failed"),
		]);
		const session = runtime.open(spec());

		const result = await session.run([input("始めて")]);

		expect(result).toEqual({
			status: "failed",
			reason: "transient_exhausted",
			message: "fetch failed",
		});
		expect(session.status().retries).toBe(2);
		expect(faux.state.callCount).toBe(3);
		expect(runtime.status().lastFailure).toEqual({
			at: NOW.toISOString(),
			message: "fetch failed",
		});
	});

	it("成功した応答に付いた提供元の診断情報を warn で記録する", async () => {
		const { runtime, faux, logger } = await setup();
		faux.setResponses([
			() => ({
				...fauxAssistantMessage("ok"),
				diagnostics: [
					{
						type: "provider_transport_failure",
						timestamp: NOW.getTime(),
						error: { name: "Error", message: "WebSocket error", stack: "Error: WebSocket error" },
						details: { configuredTransport: "auto", fallbackTransport: "sse" },
					},
				],
			}),
		]);
		const session = runtime.open(spec());

		await expect(session.run([input("始めて")])).resolves.toMatchObject({ status: "completed" });

		expect(logger.entries).toContainEqual({
			level: "warn",
			event: "agent.pi.provider_diagnostic",
			context: {},
			details: {
				details: { configuredTransport: "auto", fallbackTransport: "sse" },
				error: "WebSocket error",
				sessionId: session.id,
				type: "provider_transport_failure",
			},
		});
	});

	it("SSE の 429 は再試行せず usage_limit を返す", async () => {
		const { runtime, faux } = await setup();
		faux.setResponses([
			errorStep("You have hit your ChatGPT usage limit (plus plan).", async (options) => {
				await options?.onResponse?.({ status: 429, headers: {} }, faux.getModel());
			}),
		]);

		const result = await runtime.open(spec()).run([input("始めて")]);

		expect(result).toMatchObject({ status: "failed", reason: "usage_limit" });
		expect(faux.state.callCount).toBe(1);
	});

	it("WebSocket の生イベントの usage_limit_reached を使用上限とする", async () => {
		const { runtime, faux } = await setup();
		faux.setResponses([
			errorStep("Codex error: rate limited", async (options) => {
				await options?.onProviderStreamEvent?.(
					{
						type: "error",
						status: 429,
						error: { type: "usage_limit_reached", resets_at: 1_800_000_000 },
					},
					faux.getModel(),
				);
			}),
		]);

		const result = await runtime.open(spec()).run([input("始めて")]);

		expect(result).toMatchObject({ status: "failed", reason: "usage_limit" });
	});

	it("認証失敗は auth_required を返し、ランタイムの状態に残す", async () => {
		const { runtime, faux, hasCredentials } = await setup();
		faux.setResponses([
			errorStep("OAuth refresh failed for faux: invalid_grant"),
			fauxAssistantMessage("ok"),
		]);
		const session = runtime.open(spec());

		const result = await session.run([input("始めて")]);

		expect(result).toMatchObject({ status: "failed", reason: "auth_required" });
		expect(runtime.status().auth).toBe("auth_required");
		await session.run([input("もう一度")]);
		expect(runtime.status().auth).toBe("ready");
		hasCredentials.value = false;
		expect(runtime.status().auth).toBe("missing");
	});

	it("それ以外は fatal を返す", async () => {
		const { runtime, faux } = await setup();
		faux.setResponses([
			errorStep("Invalid schema for function", async (options) => {
				await options?.onResponse?.({ status: 400, headers: {} }, faux.getModel());
			}),
		]);

		const result = await runtime.open(spec()).run([input("始めて")]);

		expect(result).toEqual({
			status: "failed",
			reason: "fatal",
			message: "Invalid schema for function",
		});
		expect(faux.state.callCount).toBe(1);
	});
});

describe("圧縮", () => {
	const bigText = (label: string) => `${label}:${"あいうえお".repeat(800)}`;

	it("直近の usage が上限を超えたら要約し、以後のリクエストは要約で置き換える", async () => {
		const { runtime, faux, transcriptDir } = await setup({
			models: [{ id: "faux-1", contextWindow: 1_000 }],
			reserveTokens: 200,
			keepRecentTokens: 50,
		});
		const requests: { context: TranscriptContext; model: string }[] = [];
		const phases: string[] = [];
		const session = runtime.open(spec());
		faux.setResponses([
			capture(requests, "了解1"),
			(context) => {
				phases.push(session.status().phase);
				requests.push({ context, model: "summary" });
				return fauxAssistantMessage("要約本文");
			},
			capture(requests, "了解2"),
			capture(requests, "了解3"),
		]);

		await session.run([input(bigText("A"))]);
		await session.run([input(bigText("C"))]);
		await session.run([input("D")]);
		await session.close();

		expect(faux.state.callCount).toBe(4);
		expect(phases).toEqual(["compacting"]);
		const summaryPrompt = texts(requests[1]?.context.messages ?? [], "user").join("\n");
		expect(summaryPrompt).toContain("<conversation>");
		expect(summaryPrompt).toContain("A:あいう");
		expect(summaryPrompt).not.toContain("C:あいう");

		const afterCompaction = requests[2]?.context.messages ?? [];
		expect(afterCompaction[0]?.role).toBe("system");
		const userTexts = texts(afterCompaction, "user");
		expect(userTexts[0]).toContain("<summary>\n要約本文\n</summary>");
		expect(userTexts.join("\n")).not.toContain("A:あいう");
		expect(userTexts[1]).toContain("C:あいう");

		const nextRequestUserTexts = texts(requests[3]?.context.messages ?? [], "user");
		expect(nextRequestUserTexts[0]).toBe(userTexts[0]);
		expect(nextRequestUserTexts.at(-1)).toBe(
			'<luna_input kind="discord_message">\nD\n</luna_input>',
		);

		const transcript = await readTranscript(transcriptDir, session.id);
		expect(transcript.filter((line) => line.type === "compaction")).toEqual([
			expect.objectContaining({ summary: "要約本文", firstKeptIndex: 3 }),
		]);
		const recordedInputs = transcript.flatMap((line) => {
			const parsed = z
				.object({ message: z.object({ role: z.literal("luna_input"), text: z.string() }) })
				.safeParse(line);
			return parsed.success ? [parsed.data.message.text.slice(0, 2)] : [];
		});
		expect(recordedInputs).toEqual(["A:", "C:", "D"]);
	});

	it("要約の一時的な失敗も run のエラーとして再試行する", async () => {
		const { runtime, faux } = await setup({
			models: [{ id: "faux-1", contextWindow: 1_000 }],
			reserveTokens: 200,
			keepRecentTokens: 50,
		});
		faux.setResponses([
			fauxAssistantMessage("了解1"),
			errorStep("fetch failed"),
			fauxAssistantMessage("要約本文"),
			fauxAssistantMessage("了解2"),
		]);
		const session = runtime.open(spec());

		await session.run([input(bigText("A"))]);
		const result = await session.run([input(bigText("C"))]);

		expect(result).toEqual({ status: "completed", finalText: "了解2" });
		expect(session.status().retries).toBe(1);
	});
});

describe("記録", () => {
	it("開いた時点の system と spec の要約、以降のメッセージを JSONL で残す", async () => {
		const { runtime, faux, transcriptDir } = await setup();
		faux.setResponses([fauxAssistantMessage("こんにちは")]);
		const session = runtime.open(spec());

		await session.run([input("やあ")]);
		await session.close();

		const lines = await readTranscript(transcriptDir, session.id);
		expect(lines[0]).toEqual({
			type: "session_open",
			at: NOW.toISOString(),
			sessionId: session.id,
			kind: "conversation",
			label: "テスト会話",
			model: { provider: "faux", model: "faux-1", thinking: "off" },
		});
		expect(
			lines
				.slice(1)
				.map(
					(line) => z.object({ message: z.object({ role: z.string() }) }).parse(line).message.role,
				),
		).toEqual(["system", "luna_input", "assistant"]);
		expect(lines[1]).toMatchObject({
			message: { role: "system", content: expect.stringMatching(/^あなたはルナです。\n\n/u) },
		});
	});
});

describe("一時ディレクトリ", () => {
	it("セッションごとに所有者だけのディレクトリを作り、汎用ツールとシステムプロンプトへ渡す", async () => {
		const { runtime, faux, transcriptDir, scratchRoot, harnessContexts } = await setup();
		faux.setResponses([fauxAssistantMessage("はい")]);
		const session = runtime.open(spec());
		await session.run([input("やあ")]);
		await session.close();

		const scratchDir = path.join(scratchRoot, session.id);
		expect((await stat(scratchDir)).mode & 0o777).toBe(0o700);
		expect(harnessContexts.map((context) => context.scratchDir)).toEqual([scratchDir]);
		const lines = await readTranscript(transcriptDir, session.id);
		expect(lines[1]).toMatchObject({
			message: {
				role: "system",
				content: `あなたはルナです。\n\n# Scratch directory\n\nThis session's scratch directory is ${scratchDir}. exec_command sets it as TMPDIR.`,
			},
		});
	});
});

describe("モデルと状態", () => {
	it("setModel は次のリクエストから効き、未知のモデルは拒否する", async () => {
		const { runtime, faux } = await setup();
		const requests: { context: TranscriptContext; model: string }[] = [];
		faux.setResponses([capture(requests, "1"), capture(requests, "2")]);
		const session = runtime.open(spec());

		await session.run([input("1")]);
		session.setModel({ provider: "faux", model: "faux-2", thinking: "off" });
		await session.run([input("2")]);

		expect(requests.map((request) => request.model)).toEqual(["faux-1", "faux-2"]);
		expect(session.status().model).toEqual({ provider: "faux", model: "faux-2", thinking: "off" });
		expect(() => {
			session.setModel({ provider: "faux", model: "missing", thinking: "off" });
		}).toThrow("Unknown model: faux/missing");
	});

	it("listModels はカタログを AgentModel にし、open は未知のモデルを拒否する", async () => {
		const { runtime } = await setup();

		expect(runtime.listModels()).toEqual([
			{
				provider: "faux",
				model: "faux-1",
				displayName: "Faux One",
				supportedThinkingLevels: expect.arrayContaining(["off", "high"]),
			},
			{
				provider: "faux",
				model: "faux-2",
				displayName: "Faux Two",
				supportedThinkingLevels: ["off"],
			},
		]);
		expect(() =>
			runtime.open(spec({ model: { provider: "faux", model: "missing", thinking: "off" } })),
		).toThrow("Unknown model: faux/missing");
	});

	it("status は使用枠と開いているセッションを返す", async () => {
		const { runtime } = await setup();
		const session = runtime.open(spec());
		const usage = { fetchedAt: NOW.toISOString(), planType: "plus", limits: [] };

		runtime.setUsage(usage);

		expect(runtime.status()).toEqual({
			auth: "ready",
			usage,
			lastFailure: null,
			sessions: [
				{
					id: session.id,
					kind: "conversation",
					label: "テスト会話",
					model: { provider: "faux", model: "faux-1", thinking: "off" },
					phase: "idle",
					phaseSince: NOW.toISOString(),
					retries: 0,
				},
			],
		});
	});

	it("close 後は操作を拒否し、汎用ツールを片付けてセッション一覧から外す", async () => {
		const { runtime, harnessDispose } = await setup();
		const session = runtime.open(spec());

		await session.close();
		await session.close();

		expect(harnessDispose).toHaveBeenCalledTimes(1);
		expect(session.status().phase).toBe("closed");
		expect(runtime.status().sessions).toEqual([]);
		await expect(session.run([input("x")])).rejects.toBeInstanceOf(SessionClosedError);
		expect(() => {
			session.steer(input("x"));
		}).toThrow(SessionClosedError);
		expect(() => {
			session.setModel({ provider: "faux", model: "faux-2", thinking: "off" });
		}).toThrow(SessionClosedError);
	});

	it("実行中の close は中断してから閉じる", async () => {
		const { runtime, faux } = await setup({ retryDelaysMs: [60_000] });
		faux.setResponses([errorStep("fetch failed")]);
		const session = runtime.open(spec());

		const running = session.run([input("始めて")]);
		await waitForPhase(session, "retry_wait");
		await session.close();

		await expect(running).resolves.toEqual({ status: "aborted" });
		expect(session.status().phase).toBe("closed");
	});
});
