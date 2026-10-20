import { z } from "zod";

import { jsonValueSchema } from "../../../shared/json";
import type { JsonObject } from "../../../shared/json";

export const TASK_REPORTED_EVENT_TYPE = "luna.task.reported.v1";
export const TASK_EVENT_SOURCE = "luna/task";

const isoDateTime = z.iso.datetime({ offset: true });

const taskOriginSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("conversation"),
		session: z.strictObject({
			key: z.string().min(1),
			source: z.string().min(1),
			context: jsonValueSchema,
		}),
	}),
	z.strictObject({
		kind: z.literal("event"),
		eventId: z.string().min(1),
		eventType: z.string().min(1),
	}),
]);

export const taskReportKindSchema = z.enum([
	"progress",
	"milestone",
	"question",
	"result",
	"failure",
]);

const taskReportSchema = z.strictObject({
	seq: z.number().int().min(1),
	kind: taskReportKindSchema,
	summary: z.string(),
	artifacts: z.array(z.string()),
	reportedAt: isoDateTime,
	deliveredAt: isoDateTime.nullable(),
});

const taskMessageSchema = z.strictObject({
	id: z.string().min(1),
	text: z.string(),
	receivedAt: isoDateTime,
	deliveredAt: isoDateTime.nullable(),
});

export const taskSchema = z.strictObject({
	version: z.literal(1),
	id: z.string().min(1),
	title: z.string(),
	instructions: z.string(),
	origin: taskOriginSchema,
	private: z.boolean(),
	status: z.enum(["queued", "running", "waiting_input", "completed", "failed", "cancelled"]),
	attempts: z.number().int().min(0),
	createdAt: isoDateTime,
	updatedAt: isoDateTime,
	reports: z.array(taskReportSchema),
	messages: z.array(taskMessageSchema),
	outcome: z.string().nullable(),
});

export type Task = Readonly<z.infer<typeof taskSchema>>;
export type TaskOrigin = Task["origin"];
export type TaskStatus = Task["status"];
export type TaskReport = Task["reports"][number];
export type TaskReportKind = z.infer<typeof taskReportKindSchema>;
export type TaskMessage = Task["messages"][number];

export type TaskBoardStatus = Readonly<{
	maxConcurrent: number;
	running: number;
	tasks: readonly Task[];
}>;

export type TaskViewer =
	| Readonly<{ kind: "conversation"; sessionKey: string }>
	| Readonly<{ kind: "event" }>;

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "cancelled"]);
const NOTIFIED_REPORT_KINDS: ReadonlySet<TaskReportKind> = new Set([
	"milestone",
	"question",
	"result",
	"failure",
]);

export function isTerminalStatus(status: TaskStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

export function isNotifiedReport(report: TaskReport): boolean {
	return NOTIFIED_REPORT_KINDS.has(report.kind);
}

export function isVisibleTo(task: Task, viewer: TaskViewer): boolean {
	if (viewer.kind === "event") return true;
	if (task.origin.kind === "conversation" && task.origin.session.key === viewer.sessionKey) {
		return true;
	}
	return !task.private;
}

export function describeOrigin(origin: TaskOrigin): string {
	return origin.kind === "conversation" ? origin.session.key : origin.eventType;
}

export function summarizeTask(task: Task): JsonObject {
	const latest = task.reports.at(-1);
	return {
		id: task.id,
		title: task.title,
		status: task.status,
		origin: describeOrigin(task.origin),
		created_at: task.createdAt,
		updated_at: task.updatedAt,
		latest_report:
			latest === undefined
				? null
				: { kind: latest.kind, summary: latest.summary, reported_at: latest.reportedAt },
		undelivered_messages: task.messages.filter((message) => message.deliveredAt == null).length,
	};
}
