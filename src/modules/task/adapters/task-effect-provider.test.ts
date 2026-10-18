import { describe, expect, it, vi } from "vitest";

import { createEffectOutputContract } from "../../effect/application/effect-output-contract";
import { createEffectRegistry } from "../../effect/application/effect-registry";
import type { EffectExecution } from "../../effect/domain/effect";
import type { TaskService } from "../application/task-service";
import type { Task } from "../domain/task";
import {
	createTaskBoardEffectProvider,
	createTaskReportEffectProvider,
} from "./task-effect-provider";

const execution: EffectExecution = {
	ownerId: "owner-1",
	origin: { kind: "event", eventId: "event-1", eventType: "system.heartbeat.fired.v1" },
};

describe("task effect providers", () => {
	it("task.create・message・cancelへ実行元のoriginを渡す", async () => {
		const board = createBoard();
		const contract = createEffectOutputContract(
			createEffectRegistry([createTaskBoardEffectProvider(board)]),
		);
		const output = contract.parse(
			JSON.stringify({
				effects: [
					{ type: "task.create", input: { title: "調査", instructions: "調べる" } },
					{ type: "task.message", input: { task_id: "task-1", text: "追加" } },
					{ type: "task.cancel", input: { task_id: "task-1", reason: null } },
				],
			}),
		);

		const results = await Promise.all(
			output.effects.map(async (effect) => await effect.run(execution)),
		);

		expect(results).toEqual([
			{ task_id: "task-1", status: "queued" },
			{ task_id: "task-1", status: "running" },
			{ task_id: "task-1", status: "cancelled" },
		]);
		expect(board.create).toHaveBeenCalledWith(execution.origin, {
			title: "調査",
			instructions: "調べる",
		});
		expect(board.message).toHaveBeenCalledWith(execution.origin, "task-1", "追加");
		expect(board.cancel).toHaveBeenCalledWith(execution.origin, "task-1", null);
	});

	it("task.reportのartifacts未指定を空配列として渡す", async () => {
		const board = createBoard();
		const contract = createEffectOutputContract(
			createEffectRegistry([createTaskReportEffectProvider(board)]),
		);
		const [effect] = contract.parse(
			JSON.stringify({
				effects: [
					{ type: "task.report", input: { kind: "result", summary: "完了", artifacts: null } },
				],
			}),
		).effects;

		await expect(effect?.run(execution)).resolves.toEqual({ seq: 1, status: "completed" });
		expect(board.report).toHaveBeenCalledWith(execution.origin, {
			kind: "result",
			summary: "完了",
			artifacts: [],
		});
	});

	it.each([
		["空のtitle", { type: "task.create", input: { title: " ", instructions: "x" } }],
		[
			"長すぎるtitle",
			{ type: "task.create", input: { title: "x".repeat(121), instructions: "x" } },
		],
		[
			"相対path",
			{ type: "task.report", input: { kind: "result", summary: "x", artifacts: ["a"] } },
		],
		["未知のkind", { type: "task.report", input: { kind: "done", summary: "x", artifacts: null } }],
	])("%sを拒否する", (_name, effect) => {
		const contract = createEffectOutputContract(
			createEffectRegistry([
				createTaskBoardEffectProvider(createBoard()),
				createTaskReportEffectProvider(createBoard()),
			]),
		);

		expect(() => contract.parse(JSON.stringify({ effects: [effect] }))).toThrow("Invalid effect");
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
