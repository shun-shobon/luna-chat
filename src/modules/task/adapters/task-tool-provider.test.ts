import { describe, expect, it, vi } from "vitest";

import type { JsonValue } from "../../../shared/json";
import type { AgentTool } from "../../agent/ports/outbound/agent-session-port";
import { createToolSet } from "../../tool/application/tool-set";
import type { ToolOrigin } from "../../tool/domain/tool";
import type { ToolProvider } from "../../tool/ports/tool-provider";
import type { TaskService } from "../application/task-service";
import type { Task } from "../domain/task";
import { createTaskBoardToolProvider, createTaskReportToolProvider } from "./task-tool-provider";

const eventOrigin: ToolOrigin = {
	kind: "event",
	eventId: "event-1",
	eventType: "system.heartbeat.fired.v1",
};
const taskOrigin: ToolOrigin = { kind: "task", taskId: "task-1" };

describe("task tool providers", () => {
	it("依頼側にはtask_create・task_message・task_cancelだけを、作業側にはtask_reportだけを公開する", () => {
		expect(createTaskBoardToolProvider(createBoard()).definitions.map(({ name }) => name)).toEqual([
			"task_create",
			"task_message",
			"task_cancel",
		]);
		expect(createTaskReportToolProvider(createBoard()).definitions.map(({ name }) => name)).toEqual(
			["task_report"],
		);
	});

	it("task_create・task_message・task_cancelへ実行元のoriginを渡す", async () => {
		const board = createBoard();
		const tools = bind(createTaskBoardToolProvider(board), eventOrigin);

		const results = [
			await call(tools, "task_create", { title: " 調査 ", instructions: "調べる" }),
			await call(tools, "task_message", { task_id: "task-1", text: "追加" }),
			await call(tools, "task_cancel", { task_id: "task-1" }),
			await call(tools, "task_cancel", { task_id: "task-1", reason: "不要" }),
		];

		expect(results).toEqual([
			{ task_id: "task-1", status: "queued" },
			{ task_id: "task-1", status: "running" },
			{ task_id: "task-1", status: "cancelled" },
			{ task_id: "task-1", status: "cancelled" },
		]);
		expect(board.create).toHaveBeenCalledWith(eventOrigin, {
			title: "調査",
			instructions: "調べる",
		});
		expect(board.message).toHaveBeenCalledWith(eventOrigin, "task-1", "追加");
		expect(board.cancel.mock.calls).toEqual([
			[eventOrigin, "task-1", null],
			[eventOrigin, "task-1", "不要"],
		]);
	});

	it("task_reportのartifacts未指定を空配列として渡す", async () => {
		const board = createBoard();
		const tools = bind(createTaskReportToolProvider(board), taskOrigin);

		await expect(call(tools, "task_report", { kind: "result", summary: "完了" })).resolves.toEqual({
			seq: 1,
			status: "completed",
		});
		await call(tools, "task_report", {
			kind: "milestone",
			summary: "途中",
			artifacts: ["/workspace/report.md"],
		});

		expect(board.report.mock.calls).toEqual([
			[taskOrigin, { kind: "result", summary: "完了", artifacts: [] }],
			[taskOrigin, { kind: "milestone", summary: "途中", artifacts: ["/workspace/report.md"] }],
		]);
	});

	it.each([
		["空のtitle", "task_create", { title: " ", instructions: "x" }],
		["長すぎるtitle", "task_create", { title: "x".repeat(121), instructions: "x" }],
		["未知のfield", "task_message", { task_id: "task-1", text: "x", extra: true }],
		["空のtask_id", "task_cancel", { task_id: "" }],
		["相対path", "task_report", { kind: "result", summary: "x", artifacts: ["a"] }],
		["未知のkind", "task_report", { kind: "done", summary: "x" }],
		["長すぎるsummary", "task_report", { kind: "result", summary: "x".repeat(4_001) }],
	])("%sをTaskService呼び出し前に拒否する", async (_label, name, input) => {
		const board = createBoard();
		const tools = [
			...bind(createTaskBoardToolProvider(board), eventOrigin),
			...bind(createTaskReportToolProvider(board), taskOrigin),
		];

		await expect(
			tool(tools, name).execute(input, new AbortController().signal),
		).resolves.toMatchObject({ isError: true });
		expect(board.create).not.toHaveBeenCalled();
		expect(board.message).not.toHaveBeenCalled();
		expect(board.cancel).not.toHaveBeenCalled();
		expect(board.report).not.toHaveBeenCalled();
	});

	it("TaskServiceの拒否をisErrorのメッセージとしてモデルへ返す", async () => {
		const board = createBoard();
		board.message.mockRejectedValueOnce(new Error("Task task-9 is not available here"));
		const tools = bind(createTaskBoardToolProvider(board), eventOrigin);

		await expect(
			tool(tools, "task_message").execute(
				{ task_id: "task-9", text: "x" },
				new AbortController().signal,
			),
		).resolves.toMatchObject({ text: "Task task-9 is not available here", isError: true });
	});
});

const queuedTask: Task = {
	version: 1,
	id: "task-1",
	title: "調査",
	instructions: "調べる",
	origin: { kind: "event", eventId: "event-1", eventType: "system.heartbeat.fired.v1" },
	private: true,
	status: "queued",
	attempts: 0,
	createdAt: "2026-10-19T00:00:00.000Z",
	updatedAt: "2026-10-19T00:00:00.000Z",
	reports: [],
	messages: [],
	outcome: null,
};

function createBoard() {
	return {
		cancel: vi.fn<TaskService["cancel"]>(async () => "cancelled"),
		create: vi.fn<TaskService["create"]>(async () => queuedTask),
		message: vi.fn<TaskService["message"]>(async () => "running"),
		report: vi.fn<TaskService["report"]>(async () => ({ seq: 1, status: "completed" })),
	};
}

function bind(provider: ToolProvider, origin: ToolOrigin): readonly AgentTool[] {
	return createToolSet([provider], { log: vi.fn() }).bind({ ownerId: "owner-1", origin });
}

function tool(tools: readonly AgentTool[], name: string): AgentTool {
	const found = tools.find((candidate) => candidate.name === name);
	if (found === undefined) throw new Error(`Missing tool ${name}`);
	return found;
}

async function call(tools: readonly AgentTool[], name: string, input: JsonValue): Promise<unknown> {
	const result = await tool(tools, name).execute(input, new AbortController().signal);
	if (result.isError) throw new Error(`${name} failed: ${result.text}`);
	return JSON.parse(result.text);
}
