import { isAbsolute } from "node:path";

import { z } from "zod";

import { defineTool } from "../../tool/ports/tool-provider";
import type { ToolProvider } from "../../tool/ports/tool-provider";
import type { TaskService } from "../application/task-service";
import { taskReportKindSchema } from "../domain/task";
import type { WorkerCatalog, WorkerChoice } from "../domain/task";

type TaskBoard = Pick<TaskService, "cancel" | "create" | "message" | "report">;

function boundedText(maximum: number) {
	return z.string().trim().min(1).max(maximum);
}

function createInputSchema(workers: WorkerCatalog) {
	const [first, ...rest] = workers.choices;
	return z.strictObject({
		title: boundedText(120),
		instructions: boundedText(20_000),
		worker: z.enum([first.name, ...rest.map((choice) => choice.name)]).optional(),
	});
}

function describeTaskCreate(workers: WorkerCatalog): string {
	const choices = workers.choices.map(
		(choice) =>
			`- ${choice.name}${choice.name === workers.defaultName ? " (default)" : ""}: ${choice.description}`,
	);
	return [
		"Delegate long work to a background worker. Returns the task id at once; the worker reports back later.",
		"Choose the worker that fits the work; omit worker to use the default.",
		...choices,
	].join("\n");
}

function findWorker(workers: WorkerCatalog, name: string | undefined): WorkerChoice {
	const wanted = name ?? workers.defaultName;
	const worker = workers.choices.find((choice) => choice.name === wanted);
	if (worker === undefined) throw new Error(`Unknown worker ${wanted}`);
	return worker;
}
const messageInputSchema = z.strictObject({ task_id: boundedText(200), text: boundedText(8_000) });
const cancelInputSchema = z.strictObject({
	task_id: boundedText(200),
	reason: boundedText(2_000).optional(),
});
const reportInputSchema = z.strictObject({
	kind: taskReportKindSchema,
	summary: boundedText(4_000),
	artifacts: z.array(z.string().refine(isAbsolute, "Artifact paths must be absolute")).optional(),
});

export function createTaskBoardToolProvider(
	tasks: TaskBoard,
	workers: WorkerCatalog,
): ToolProvider {
	return Object.freeze({
		definitions: Object.freeze([
			defineTool({
				name: "task_create",
				description: describeTaskCreate(workers),
				inputSchema: createInputSchema(workers),
				parseInput: (input) => ({
					title: input.title,
					instructions: input.instructions,
					worker: findWorker(workers, input.worker),
				}),
				execute: async (input, execution) => {
					const task = await tasks.create(execution.origin, input);
					return { task_id: task.id, worker: task.worker.name, status: task.status };
				},
				describeTarget: () => null,
			}),
			defineTool({
				name: "task_message",
				description:
					"Send an answer, a correction, or new instructions to a background task that is still open.",
				inputSchema: messageInputSchema,
				parseInput: (input) => input,
				execute: async (input, execution) => ({
					task_id: input.task_id,
					status: await tasks.message(execution.origin, input.task_id, input.text),
				}),
				describeTarget: (input) => ({ kind: "task", taskId: input.task_id }),
			}),
			defineTool({
				name: "task_cancel",
				description: "Stop a background task that is no longer wanted.",
				inputSchema: cancelInputSchema,
				parseInput: (input) => input,
				execute: async (input, execution) => ({
					task_id: input.task_id,
					status: await tasks.cancel(execution.origin, input.task_id, input.reason ?? null),
				}),
				describeTarget: (input) => ({ kind: "task", taskId: input.task_id }),
			}),
		]),
		release: async () => {},
	});
}

export function createTaskReportToolProvider(tasks: TaskBoard): ToolProvider {
	return Object.freeze({
		definitions: Object.freeze([
			defineTool({
				name: "task_report",
				description:
					"Report on the task you are working on. progress only updates the task board; milestone, question, result, and failure are delivered to the requester. question, result, and failure end your work.",
				inputSchema: reportInputSchema,
				parseInput: (input) => input,
				execute: async (input, execution) => {
					const reported = await tasks.report(execution.origin, {
						kind: input.kind,
						summary: input.summary,
						artifacts: input.artifacts ?? [],
					});
					return { seq: reported.seq, status: reported.status };
				},
				describeTarget: () => null,
			}),
		]),
		release: async () => {},
	});
}
