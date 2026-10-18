import { isAbsolute } from "node:path";

import { z } from "zod";

import { defineEffect } from "../../effect/ports/effect-provider";
import type { EffectProvider } from "../../effect/ports/effect-provider";
import type { TaskService } from "../application/task-service";
import { taskReportKindSchema } from "../domain/task";

type TaskBoard = Pick<TaskService, "cancel" | "create" | "message" | "report">;

// Structured Outputs のJSON Schemaへ長さ制約を出さないため、zodのmin/maxではなくrefineで検証する。
function boundedText(maximum: number) {
	return z.string().superRefine((value, context) => {
		if (value.trim().length === 0) {
			context.addIssue({ code: "custom", message: "String must not be empty" });
		}
		if (value.length > maximum) {
			context.addIssue({
				code: "custom",
				message: `String must not exceed ${String(maximum)} characters`,
			});
		}
	});
}

const absolutePathSchema = z.string().superRefine((value, context) => {
	if (!isAbsolute(value)) context.addIssue({ code: "custom", message: "Path must be absolute" });
});

const createInputSchema = z.strictObject({
	title: boundedText(120),
	instructions: boundedText(20_000),
});
const messageInputSchema = z.strictObject({ task_id: boundedText(200), text: boundedText(8_000) });
const cancelInputSchema = z.strictObject({
	task_id: boundedText(200),
	reason: boundedText(2_000).nullable(),
});
const reportInputSchema = z.strictObject({
	kind: taskReportKindSchema,
	summary: boundedText(4_000),
	artifacts: z.array(absolutePathSchema).nullable(),
});

export function createTaskBoardEffectProvider(tasks: TaskBoard): EffectProvider {
	return Object.freeze({
		definitions: Object.freeze([
			defineEffect({
				type: "task.create",
				agentInputSchema: createInputSchema,
				parseInput: (input) => input,
				execute: async (input, execution) => {
					const task = await tasks.create(execution.origin, input);
					return { task_id: task.id, status: task.status };
				},
				describeTarget: () => null,
			}),
			defineEffect({
				type: "task.message",
				agentInputSchema: messageInputSchema,
				parseInput: (input) => input,
				execute: async (input, execution) => ({
					task_id: input.task_id,
					status: await tasks.message(execution.origin, input.task_id, input.text),
				}),
				describeTarget: (input) => ({ kind: "task", taskId: input.task_id }),
			}),
			defineEffect({
				type: "task.cancel",
				agentInputSchema: cancelInputSchema,
				parseInput: (input) => input,
				execute: async (input, execution) => ({
					task_id: input.task_id,
					status: await tasks.cancel(execution.origin, input.task_id, input.reason),
				}),
				describeTarget: (input) => ({ kind: "task", taskId: input.task_id }),
			}),
		]),
		release: async () => {},
	});
}

export function createTaskReportEffectProvider(tasks: TaskBoard): EffectProvider {
	return Object.freeze({
		definitions: Object.freeze([
			defineEffect({
				type: "task.report",
				agentInputSchema: reportInputSchema,
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
