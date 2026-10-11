import { readFileSync, writeFileSync } from "node:fs";
import { readFile as readFileAsync, writeFile as writeFileAsync } from "node:fs/promises";

import { parse, stringify } from "smol-toml";
import { z } from "zod";

import { isValidFiveFieldCron } from "../domain/cron-expression";
import { EMPTY_WORKSPACE_SCHEDULE } from "../domain/workspace-schedule";
import type { WorkspaceSchedule } from "../domain/workspace-schedule";

const ScheduleJobBaseSchema = z.strictObject({
	enabled: z.boolean(),
	id: z.string().refine((value) => value.trim().length > 0, "id must not be blank"),
	prompt: z.string().refine((value) => value.trim().length > 0, "prompt must not be blank"),
});

const RecurringScheduleJobSchema = ScheduleJobBaseSchema.extend({
	cron: z.string().min(1).refine(isValidFiveFieldCron, {
		message: "cron must be a valid five-field cron expression.",
	}),
	kind: z.literal("recurring"),
});

const OneShotScheduleJobSchema = ScheduleJobBaseSchema.extend({
	at: z.iso.datetime({ offset: true }),
	kind: z.literal("one_shot"),
});

const WorkspaceScheduleSchema = z
	.strictObject({
		jobs: z
			.array(z.discriminatedUnion("kind", [RecurringScheduleJobSchema, OneShotScheduleJobSchema]))
			.default([]),
	})
	.superRefine((schedule, context) => {
		const seenIds = new Set<string>();
		for (const [index, job] of schedule.jobs.entries()) {
			if (seenIds.has(job.id)) {
				context.addIssue({
					code: "custom",
					message: `job id must be unique: ${job.id}`,
					path: ["jobs", index, "id"],
				});
			}
			seenIds.add(job.id);
		}
	});

class WorkspaceScheduleError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkspaceScheduleError";
	}
}

export async function readWorkspaceSchedule(schedulePath: string): Promise<WorkspaceSchedule> {
	let source: string;
	try {
		source = await readFileAsync(schedulePath, "utf8");
	} catch (error: unknown) {
		throw new WorkspaceScheduleError("cron.toml must be readable.", { cause: error });
	}

	return parseWorkspaceSchedule(source);
}

export function parseWorkspaceSchedule(source: string): WorkspaceSchedule {
	let parsedToml: unknown;
	try {
		parsedToml = parse(source);
	} catch (error: unknown) {
		throw new WorkspaceScheduleError("cron.toml is invalid TOML.", { cause: error });
	}

	const result = WorkspaceScheduleSchema.safeParse(parsedToml);
	if (!result.success) {
		throw new WorkspaceScheduleError(`cron.toml is invalid: ${z.prettifyError(result.error)}`);
	}

	return {
		jobs: result.data.jobs,
	};
}

export function serializeWorkspaceSchedule(schedule: WorkspaceSchedule): string {
	return stringify({ jobs: schedule.jobs });
}

export async function createWorkspaceScheduleFile(schedulePath: string): Promise<void> {
	await writeFileAsync(schedulePath, serializeWorkspaceSchedule(EMPTY_WORKSPACE_SCHEDULE), {
		flag: "wx",
	});
}

function writeWorkspaceSchedule(schedulePath: string, schedule: WorkspaceSchedule): void {
	try {
		writeFileSync(schedulePath, serializeWorkspaceSchedule(schedule), "utf8");
	} catch (error: unknown) {
		throw new WorkspaceScheduleError("cron.toml could not be written.", { cause: error });
	}
}

export function removeWorkspaceScheduleJob(schedulePath: string, jobId: string): void {
	let source: string;
	try {
		source = readFileSync(schedulePath, "utf8");
	} catch (error: unknown) {
		throw new WorkspaceScheduleError("cron.toml must be readable.", { cause: error });
	}

	const schedule = parseWorkspaceSchedule(source);
	const jobs = schedule.jobs.filter((job) => job.id !== jobId);
	if (jobs.length === schedule.jobs.length) {
		return;
	}

	writeWorkspaceSchedule(schedulePath, { jobs });
}
