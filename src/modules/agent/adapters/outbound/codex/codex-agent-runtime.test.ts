import { describe, expect, it, vi } from "vitest";

import type { AgentTurnRequest } from "../../../ports/outbound/agent-runtime-port";
import { CodexAgentRuntime } from "./codex-agent-runtime";
import type { CodexLineHandlers, CodexLineTransport } from "./codex-stdio-process";
import { TurnNotSteerableError } from "./codex-turn-tracker";
import { JsonRpcProtocolError } from "./json-rpc-connection";

class FakeTransport implements CodexLineTransport {
	readonly close = vi.fn(async () => undefined);
	readonly writes: object[] = [];
	#handlers: CodexLineHandlers | undefined;

	public readonly open = (handlers: CodexLineHandlers): CodexLineTransport => {
		this.#handlers = handlers;
		return this;
	};

	public emit(value: object): void {
		this.emitLine(JSON.stringify(value));
	}

	public emitLine(line: string): void {
		this.#handlers?.onLine(line);
	}

	public writeLine(value: object): void {
		this.writes.push(value);
	}
}

const INITIALIZE_RESPONSE = {
	id: 1,
	result: {
		codexHome: "/codex-home",
		platformFamily: "unix",
		platformOs: "macos",
		userAgent: "codex-test",
	},
};

function startRuntime(
	transport: FakeTransport,
	options: { onFailure?: (error: Error) => void; signal?: AbortSignal } = {},
): Promise<CodexAgentRuntime> {
	return CodexAgentRuntime.start({
		onFailure: options.onFailure ?? (() => undefined),
		openTransport: transport.open,
		rpcTimeoutMs: 1_000,
		signal: options.signal ?? new AbortController().signal,
	});
}

async function initializeRuntime(transport: FakeTransport): Promise<CodexAgentRuntime> {
	const starting = startRuntime(transport);
	transport.emit(INITIALIZE_RESPONSE);
	return await starting;
}

function turnRequest(input: string): AgentTurnRequest {
	return {
		input,
		outputSchema: {
			additionalProperties: false,
			properties: { value: { type: "string" } },
			required: ["value"],
			type: "object",
		},
	};
}

describe("CodexAgentRuntime", () => {
	it("起動中にabortされたらinitializeを待たずにtransportを閉じて失敗する", async () => {
		const transport = new FakeTransport();
		const controller = new AbortController();
		const starting = startRuntime(transport, { signal: controller.signal });

		controller.abort();

		await expect(starting).rejects.toThrow("closed");
		expect(transport.close).toHaveBeenCalledOnce();
	});

	it("initialize応答直後に接続が壊れたruntimeを返さずtransportを閉じる", async () => {
		const transport = new FakeTransport();
		const starting = startRuntime(transport);

		transport.emit(INITIALIZE_RESPONSE);
		transport.emitLine("not-json");

		await expect(starting).rejects.toBeInstanceOf(JsonRpcProtocolError);
		expect(transport.close).toHaveBeenCalledOnce();
	});

	it("起動後の接続障害をonFailureへ通知し、active turnを失敗させる", async () => {
		const transport = new FakeTransport();
		const failures: Error[] = [];
		const starting = startRuntime(transport, { onFailure: (error) => failures.push(error) });
		transport.emit(INITIALIZE_RESPONSE);
		const runtime = await starting;
		const turnStarting = runtime.startTurn("thread-1", turnRequest("hello"));
		transport.emit({ id: 2, result: { turn: { id: "turn-1" } } });
		const started = await turnStarting;

		transport.emitLine("not-json");

		await expect(started.completion).rejects.toBeInstanceOf(JsonRpcProtocolError);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toBeInstanceOf(JsonRpcProtocolError);
	});

	it("完了済みturn宛てに遅れて届いた通知は無視し、未知のturn宛ては接続障害とする", async () => {
		const transport = new FakeTransport();
		const failures: Error[] = [];
		const starting = startRuntime(transport, { onFailure: (error) => failures.push(error) });
		transport.emit(INITIALIZE_RESPONSE);
		const runtime = await starting;
		const finalAnswer = (turnId: string) => ({
			method: "item/completed",
			params: {
				completedAtMs: 1,
				item: { phase: "final_answer", text: "{}", type: "agentMessage" },
				threadId: "thread-1",
				turnId,
			},
		});
		const turnCompleted = (turnId: string) => ({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { error: null, id: turnId, status: "completed" } },
		});

		const firstStarting = runtime.startTurn("thread-1", turnRequest("first"));
		transport.emit({ id: 2, result: { turn: { id: "turn-1" } } });
		const first = await firstStarting;
		transport.emit(finalAnswer("turn-1"));
		transport.emit(turnCompleted("turn-1"));
		await first.completion;
		const secondStarting = runtime.startTurn("thread-1", turnRequest("second"));
		transport.emit({ id: 3, result: { turn: { id: "turn-2" } } });
		const second = await secondStarting;

		transport.emit({
			method: "item/commandExecution/outputDelta",
			params: { delta: "server log", itemId: "item-1", threadId: "thread-1", turnId: "turn-1" },
		});
		transport.emit(finalAnswer("turn-2"));
		transport.emit(turnCompleted("turn-2"));
		await expect(second.completion).resolves.toEqual({ outputTexts: ["{}"], status: "completed" });
		expect(failures).toEqual([]);

		const thirdStarting = runtime.startTurn("thread-1", turnRequest("third"));
		transport.emit({ id: 4, result: { turn: { id: "turn-3" } } });
		const third = await thirdStarting;
		transport.emit({
			method: "item/commandExecution/outputDelta",
			params: { delta: "?", itemId: "item-2", threadId: "thread-1", turnId: "turn-unknown" },
		});

		await expect(third.completion).rejects.toBeInstanceOf(JsonRpcProtocolError);
		expect(failures).toHaveLength(1);
	});

	it("model/listを全ページ取得する", async () => {
		const transport = new FakeTransport();
		const runtime = await initializeRuntime(transport);
		const listing = runtime.listModels();
		transport.emit({
			id: 2,
			result: {
				data: [
					{
						model: "gpt-6-sol",
						displayName: "Sol",
						hidden: false,
						supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
					},
				],
				nextCursor: "next",
			},
		});
		await vi.waitFor(() => expect(transport.writes).toHaveLength(4));
		transport.emit({
			id: 3,
			result: {
				data: [
					{
						model: "gpt-6-astra",
						displayName: "Astra",
						hidden: false,
						supportedReasoningEfforts: [{ reasoningEffort: "high" }],
					},
				],
				nextCursor: null,
			},
		});
		await expect(listing).resolves.toHaveLength(2);
		expect(transport.writes).toContainEqual({
			id: 3,
			method: "model/list",
			params: { includeHidden: false, cursor: "next" },
		});
	});

	it("生成型に存在する thread/delete を送信する", async () => {
		const transport = new FakeTransport();
		const runtime = await initializeRuntime(transport);

		const deletion = runtime.deleteThread("thread-1");
		transport.emit({ id: 2, result: {} });

		await expect(deletion).resolves.toBeUndefined();
		expect(transport.writes).toContainEqual({
			id: 2,
			method: "thread/delete",
			params: { threadId: "thread-1" },
		});
	});

	it("thread を永続化し、承認なしの danger-full-access で開始する", async () => {
		const transport = new FakeTransport();
		const runtime = await initializeRuntime(transport);

		const opening = runtime.openThread({
			baseInstructions: "base",
			config: { feature: true },
			cwd: "/workspace",
			developerInstructions: "developer",
		});
		transport.emit({ id: 2, result: { thread: { id: "thread-1" } } });

		await expect(opening).resolves.toBe("thread-1");
		expect(transport.writes).toContainEqual({
			id: 2,
			method: "thread/start",
			params: {
				approvalPolicy: "never",
				baseInstructions: "base",
				config: { feature: true },
				cwd: "/workspace",
				developerInstructions: "developer",
				ephemeral: false,
				sandbox: "danger-full-access",
			},
		});
	});

	it("turn/start response と通知を相関し、final output を返す", async () => {
		const transport = new FakeTransport();
		const runtime = await initializeRuntime(transport);

		const request = turnRequest("hello");
		const starting = runtime.startTurn("thread-1", request);
		transport.emit({
			method: "turn/started",
			params: { threadId: "thread-1", turn: { id: "turn-1" } },
		});
		transport.emit({ id: 2, result: { turn: { id: "turn-1" } } });
		const started = await starting;

		transport.emit({
			method: "item/completed",
			params: {
				item: { phase: "final_answer", text: '{"actions":[]}', type: "agentMessage" },
				threadId: "thread-1",
				turnId: "turn-1",
			},
		});
		transport.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-1",
				turn: { error: null, id: "turn-1", status: "completed" },
			},
		});

		expect(started.turnId).toBe("turn-1");
		expect(transport.writes).toContainEqual({
			id: 2,
			method: "turn/start",
			params: {
				input: [{ text: "hello", text_elements: [], type: "text" }],
				outputSchema: request.outputSchema,
				threadId: "thread-1",
			},
		});
		await expect(started.completion).resolves.toEqual({
			outputTexts: ['{"actions":[]}'],
			status: "completed",
		});
	});

	it("turn/startへモデルと推論強度を同時に渡す", async () => {
		const transport = new FakeTransport();
		const runtime = await initializeRuntime(transport);
		const starting = runtime.startTurn("thread-1", {
			...turnRequest("hello"),
			model: "gpt-6-astra",
			effort: "high",
		});
		transport.emit({ id: 2, result: { turn: { id: "turn-1" } } });
		const started = await starting;
		expect(transport.writes).toContainEqual({
			id: 2,
			method: "turn/start",
			params: {
				input: [{ text: "hello", text_elements: [], type: "text" }],
				outputSchema: turnRequest("hello").outputSchema,
				threadId: "thread-1",
				model: "gpt-6-astra",
				effort: "high",
			},
		});
		transport.emit({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { error: null, id: "turn-1", status: "completed" } },
		});
		await started.completion;
	});

	it("final_answer 受領後の steer を RPC 送信前に拒否し、先行outputを保持する", async () => {
		const transport = new FakeTransport();
		const runtime = await initializeRuntime(transport);

		const starting = runtime.startTurn("thread-1", turnRequest("first"));
		transport.emit({ id: 2, result: { turn: { id: "turn-1" } } });
		const started = await starting;
		transport.emit({
			method: "item/completed",
			params: {
				item: {
					phase: "final_answer",
					text: '{"actions":[{"kind":"send_message","target":{"kind":"channel","channelId":"123456789012345678"},"content":"first answer","files":null}]}',
					type: "agentMessage",
				},
				threadId: "thread-1",
				turnId: "turn-1",
			},
		});

		await expect(runtime.steerTurn("thread-1", "turn-1", "second")).rejects.toBeInstanceOf(
			TurnNotSteerableError,
		);
		expect(
			transport.writes.filter((write) => Reflect.get(write, "method") === "turn/steer"),
		).toHaveLength(0);

		transport.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-1",
				turn: { error: null, id: "turn-1", status: "completed" },
			},
		});
		await expect(started.completion).resolves.toEqual({
			outputTexts: [
				'{"actions":[{"kind":"send_message","target":{"kind":"channel","channelId":"123456789012345678"},"content":"first answer","files":null}]}',
			],
			status: "completed",
		});
	});

	it("final_answer 受領前の steer は同じturnへ送信する", async () => {
		const transport = new FakeTransport();
		const runtime = await initializeRuntime(transport);

		const starting = runtime.startTurn("thread-1", turnRequest("first"));
		transport.emit({ id: 2, result: { turn: { id: "turn-1" } } });
		await starting;

		const steering = runtime.steerTurn("thread-1", "turn-1", "second");
		expect(transport.writes).toContainEqual({
			id: 3,
			method: "turn/steer",
			params: {
				expectedTurnId: "turn-1",
				input: [{ text: "second", text_elements: [], type: "text" }],
				threadId: "thread-1",
			},
		});
		transport.emit({ id: 3, result: { turnId: "turn-1" } });

		await expect(steering).resolves.toBeUndefined();
	});

	it("同じconnectionへ届く管理外threadのturn通知を管理中turnから分離する", async () => {
		const transport = new FakeTransport();
		const runtime = await initializeRuntime(transport);

		const starting = runtime.startTurn("thread-1", turnRequest("hello"));
		transport.emit({ id: 2, result: { turn: { id: "turn-1" } } });
		const started = await starting;

		transport.emit({
			method: "turn/started",
			params: { threadId: "subagent-thread", turn: { id: "subagent-turn" } },
		});
		transport.emit({
			method: "item/completed",
			params: {
				item: { type: "agentMessage", phase: "final_answer", text: '{"actions":[]}' },
				threadId: "subagent-thread",
				turnId: "subagent-turn",
			},
		});
		transport.emit({
			method: "turn/completed",
			params: {
				threadId: "subagent-thread",
				turn: { error: null, id: "subagent-turn", status: "completed" },
			},
		});
		transport.emit({
			method: "item/completed",
			params: {
				item: { phase: "final_answer", text: '{"actions":[]}', type: "agentMessage" },
				threadId: "thread-1",
				turnId: "turn-1",
			},
		});
		transport.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-1",
				turn: { error: null, id: "turn-1", status: "completed" },
			},
		});

		await expect(started.completion).resolves.toMatchObject({ status: "completed" });
	});

	it("管理中threadにactive trackerがないturn通知をprotocol fatalにする", async () => {
		const transport = new FakeTransport();
		const runtime = await initializeRuntime(transport);

		const starting = runtime.startTurn("thread-1", turnRequest("hello"));
		transport.emit({ id: 2, result: { turn: { id: "turn-1" } } });
		const started = await starting;
		transport.emit({
			method: "item/completed",
			params: {
				item: { phase: "final_answer", text: '{"actions":[]}', type: "agentMessage" },
				threadId: "thread-1",
				turnId: "turn-1",
			},
		});
		transport.emit({
			method: "turn/completed",
			params: {
				threadId: "thread-1",
				turn: { error: null, id: "turn-1", status: "completed" },
			},
		});
		await started.completion;

		transport.emit({
			method: "turn/started",
			params: { threadId: "thread-1", turn: { id: "unexpected-turn" } },
		});

		await expect(runtime.startTurn("thread-1", turnRequest("next"))).rejects.toBeInstanceOf(
			JsonRpcProtocolError,
		);
	});

	it("active turnのuser input要求を拒否してturnを中断し、failedで完了させる", async () => {
		const transport = new FakeTransport();
		const runtime = await initializeRuntime(transport);
		const starting = runtime.startTurn("thread-1", turnRequest("hello"));
		transport.emit({ id: 2, result: { turn: { id: "turn-1" } } });
		const started = await starting;

		transport.emit({
			id: "server-1",
			method: "item/tool/requestUserInput",
			params: { threadId: "thread-1", turnId: "turn-1" },
		});

		expect(transport.writes).toContainEqual({
			error: { code: -32601, message: "Interactive user input is not supported by this client." },
			id: "server-1",
		});
		expect(transport.writes).toContainEqual({
			id: 3,
			method: "turn/interrupt",
			params: { threadId: "thread-1", turnId: "turn-1" },
		});
		transport.emit({ id: 3, result: {} });
		transport.emit({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { error: null, id: "turn-1", status: "interrupted" } },
		});
		await expect(started.completion).resolves.toMatchObject({ status: "failed" });
	});

	it("active turnがないthreadのuser input要求をprotocol fatalにする", async () => {
		const transport = new FakeTransport();
		const runtime = await initializeRuntime(transport);

		transport.emit({
			id: "server-1",
			method: "item/tool/requestUserInput",
			params: { threadId: "thread-1", turnId: "turn-1" },
		});

		await expect(runtime.listModels()).rejects.toBeInstanceOf(JsonRpcProtocolError);
	});

	it("turn/start response と先行通知の turn id 不一致を protocol fatal にする", async () => {
		const transport = new FakeTransport();
		const runtime = await initializeRuntime(transport);

		const starting = runtime.startTurn("thread-1", turnRequest("hello"));
		transport.emit({
			method: "turn/started",
			params: { threadId: "thread-1", turn: { id: "turn-from-notification" } },
		});
		transport.emit({ id: 2, result: { turn: { id: "turn-from-response" } } });

		await expect(starting).rejects.toBeInstanceOf(JsonRpcProtocolError);
	});
});
