import type { JsonObject } from "../../../shared/json";
import type { AgentInputMessage } from "../../agent/ports/outbound/agent-session-port";
import type { LunaEvent } from "../../event/domain/luna-event";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type { ToolOrigin } from "../../tool/domain/tool";
import { describeRunFailure } from "../../tool/ports/agent-session-factory-port";
import type {
	OpenAgentSession,
	OpenedAgentSession,
} from "../../tool/ports/agent-session-factory-port";
import {
	describeOrigin,
	isNotifiedReport,
	isTerminalStatus,
	isVisibleTo,
	summarizeTask,
	TASK_EVENT_SOURCE,
	TASK_REPORTED_EVENT_TYPE,
} from "../domain/task";
import type {
	Task,
	TaskBoardStatus,
	TaskMessage,
	TaskOrigin,
	TaskReport,
	TaskReportKind,
	TaskStatus,
	TaskViewer,
} from "../domain/task";
import type { TaskDeliveryPort } from "../ports/task-delivery-port";
import type { TaskStorePort } from "../ports/task-store-port";

const MAX_ATTEMPTS = 5;
const SNAPSHOT_RECENT_MS = 86_400_000;
const SNAPSHOT_LIMIT = 20;
const BOARD_LIMIT = 50;

type TaskSession = Extract<TaskOrigin, { kind: "conversation" }>["session"];

type TaskServiceDependencies = Readonly<{
	createId: () => string;
	delivery: TaskDeliveryPort;
	isPrivateSession: (session: TaskSession) => boolean;
	logger: LoggerPort;
	maxConcurrent: number;
	now: () => Date;
	openSession: OpenAgentSession;
	releaseTools: (ownerId: string) => Promise<void>;
	store: TaskStorePort;
}>;

type ActiveRun = {
	nudged: boolean;
	opened: OpenedAgentSession | undefined;
	running: boolean;
	stopReason: "cancelled" | "shutdown" | undefined;
};

class TaskError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskError";
	}
}

export class TaskService {
	readonly #background = new Set<Promise<void>>();
	readonly #parked = new Map<string, OpenedAgentSession>();
	readonly #runs = new Map<string, ActiveRun>();
	readonly #tasks = new Map<string, Task>();
	readonly #writes = new Map<string, Promise<void>>();
	#accepting = false;

	constructor(private readonly dependencies: TaskServiceDependencies) {}

	async start(): Promise<void> {
		for (const task of await this.dependencies.store.loadAll()) this.#tasks.set(task.id, task);
		this.#accepting = true;
		for (const task of this.#tasks.values()) {
			if (task.status === "running") this.#update(task.id, { status: "queued" });
			for (const report of task.reports) {
				if (isNotifiedReport(report) && report.deliveredAt == null) {
					this.#deliver(task.id, report);
				}
			}
		}
		this.#pump();
	}

	stopIntake(): void {
		this.#accepting = false;
		for (const [taskId, run] of this.#runs) {
			run.stopReason ??= "shutdown";
			if (this.#require(taskId).status === "running") this.#update(taskId, { status: "queued" });
			this.#stop(run);
		}
	}

	async drain(): Promise<void> {
		this.stopIntake();
		const parked = [...this.#parked.values()];
		this.#parked.clear();
		await Promise.allSettled(parked.map(async (opened) => await this.#closeSession(opened)));
		while (this.#background.size > 0) await Promise.allSettled(this.#background);
		while (this.#writes.size > 0) await Promise.allSettled(this.#writes.values());
	}

	async create(
		origin: ToolOrigin,
		input: Readonly<{ title: string; instructions: string }>,
	): Promise<Task> {
		if (!this.#accepting) throw new TaskError("Task intake is stopped");
		if (origin.kind === "task") throw new TaskError("A background task cannot create a task");
		const now = this.#timestamp();
		const task: Task = {
			version: 1,
			id: this.dependencies.createId(),
			title: input.title,
			instructions: input.instructions,
			origin,
			private: origin.kind === "event" ? true : this.dependencies.isPrivateSession(origin.session),
			status: "queued",
			attempts: 0,
			createdAt: now,
			updatedAt: now,
			reports: [],
			messages: [],
			outcome: null,
		};
		this.#tasks.set(task.id, task);
		await this.#persist(task.id);
		this.#pump();
		return task;
	}

	async message(origin: ToolOrigin, taskId: string, text: string): Promise<TaskStatus> {
		const task = this.#openTaskFor(origin, taskId);
		this.#update(taskId, {
			messages: [
				...task.messages,
				{
					id: this.dependencies.createId(),
					text,
					receivedAt: this.#timestamp(),
					deliveredAt: null,
				},
			],
		});
		const run = this.#runs.get(taskId);
		// 質問を報告した直後に届いた返答は、実行の終わりに未配送として拾い直して続きを渡す。
		if (run?.running === true && run.opened !== undefined && task.status === "running") {
			run.opened.session.steer(this.#messagesInput(taskId));
		} else if (task.status === "waiting_input") {
			this.#update(taskId, { status: "queued" });
			this.#pump();
		}
		await this.#persist(taskId);
		return this.#require(taskId).status;
	}

	async cancel(origin: ToolOrigin, taskId: string, reason: string | null): Promise<TaskStatus> {
		this.#openTaskFor(origin, taskId);
		this.#update(taskId, { status: "cancelled", outcome: reason });
		const run = this.#runs.get(taskId);
		if (run !== undefined) {
			run.stopReason = "cancelled";
			this.#stop(run);
		}
		const parked = this.#parked.get(taskId);
		if (parked !== undefined) {
			this.#parked.delete(taskId);
			this.#track(this.#closeSession(parked));
		}
		await this.#persist(taskId);
		return "cancelled";
	}

	async report(
		origin: ToolOrigin,
		input: Readonly<{ kind: TaskReportKind; summary: string; artifacts: readonly string[] }>,
	): Promise<Readonly<{ seq: number; status: TaskStatus }>> {
		if (origin.kind !== "task") throw new TaskError("Only a task worker can report");
		const task = this.#require(origin.taskId);
		if (!this.#runs.has(task.id) || isTerminalStatus(task.status)) {
			throw new TaskError(`Task ${task.id} is not running`);
		}
		const report: TaskReport = {
			seq: task.reports.length + 1,
			kind: input.kind,
			summary: input.summary,
			artifacts: [...input.artifacts],
			reportedAt: this.#timestamp(),
			deliveredAt: null,
		};
		const status = statusAfterReport(task.status, input.kind);
		this.#update(task.id, { reports: [...task.reports, report], status });
		await this.#persist(task.id);
		if (isNotifiedReport(report)) this.#deliver(task.id, report);
		return { seq: report.seq, status };
	}

	listFor(viewer: TaskViewer): readonly JsonObject[] {
		return this.#recentTasks()
			.filter((task) => isVisibleTo(task, viewer))
			.slice(0, SNAPSHOT_LIMIT)
			.map(summarizeTask);
	}

	snapshot(): TaskBoardStatus {
		return {
			maxConcurrent: this.dependencies.maxConcurrent,
			running: this.#runs.size,
			tasks: this.#recentTasks().slice(0, BOARD_LIMIT),
		};
	}

	#recentTasks(): Task[] {
		const nowMs = this.dependencies.now().getTime();
		return [...this.#tasks.values()]
			.filter(
				(task) =>
					!isTerminalStatus(task.status) || nowMs - Date.parse(task.updatedAt) < SNAPSHOT_RECENT_MS,
			)
			.toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
	}

	#pump(): void {
		if (!this.#accepting) return;
		const queued = [...this.#tasks.values()]
			.filter((task) => task.status === "queued" && !this.#runs.has(task.id))
			.toSorted((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
		for (const task of queued) {
			if (this.#runs.size >= this.dependencies.maxConcurrent) return;
			const run: ActiveRun = {
				nudged: false,
				opened: this.#parked.get(task.id),
				running: false,
				stopReason: undefined,
			};
			this.#parked.delete(task.id);
			this.#runs.set(task.id, run);
			this.#track(this.#drive(task.id, run));
		}
	}

	async #drive(taskId: string, run: ActiveRun): Promise<void> {
		const resumed = run.opened !== undefined;
		try {
			const task = this.#update(taskId, {
				status: "running",
				attempts: resumed ? this.#require(taskId).attempts : this.#require(taskId).attempts + 1,
			});
			if (task.attempts > MAX_ATTEMPTS) {
				this.#fail(taskId, `Task was interrupted ${String(MAX_ATTEMPTS)} times.`);
				return;
			}
			const opened = run.opened ?? (await this.dependencies.openSession({ kind: "task", taskId }));
			run.opened = opened;
			if (isStopped(run)) return;
			let messages: readonly AgentInputMessage[] | undefined = [
				resumed ? this.#messagesInput(taskId) : this.#assignmentInput(taskId),
			];
			while (messages !== undefined) messages = await this.#runOnce(taskId, run, opened, messages);
		} catch (error: unknown) {
			if (isStopped(run)) return;
			this.dependencies.logger.child({ taskId }).error("task.run_failed", { error });
			this.#fail(taskId, error instanceof Error ? error.message : String(error));
		} finally {
			this.#runs.delete(taskId);
			if (run.opened !== undefined) await this.#closeSession(run.opened);
			this.#pump();
		}
	}

	// 次の実行の入力を返す。undefinedならこの実行を終える。
	async #runOnce(
		taskId: string,
		run: ActiveRun,
		opened: OpenedAgentSession,
		messages: readonly AgentInputMessage[],
	): Promise<readonly AgentInputMessage[] | undefined> {
		run.running = true;
		const result = await opened.session.run(messages).finally(() => {
			run.running = false;
		});
		if (isStopped(run)) return undefined;
		if (result.status !== "completed") throw new Error(describeRunFailure(result));
		const current = this.#require(taskId);
		if (isTerminalStatus(current.status)) return undefined;
		if (current.messages.some((message) => message.deliveredAt == null)) {
			this.#update(taskId, { status: "running" });
			return [this.#messagesInput(taskId)];
		}
		if (current.status === "waiting_input") {
			this.#parked.set(taskId, opened);
			run.opened = undefined;
			return undefined;
		}
		if (!run.nudged) {
			run.nudged = true;
			return [{ kind: "task_check", text: JSON.stringify({ task_id: taskId }) }];
		}
		this.#fail(taskId, "Worker ended without a result, question, or failure report.");
		return undefined;
	}

	#assignmentInput(taskId: string): AgentInputMessage {
		const task = this.#markMessagesDelivered(taskId);
		return {
			kind: "task_assignment",
			text: JSON.stringify({
				id: task.id,
				title: task.title,
				instructions: task.instructions,
				origin: describeOrigin(task.origin),
				created_at: task.createdAt,
				attempt: task.attempts,
				previous_reports: task.reports.map(toReportJson),
				messages: task.messages.map(toMessageJson),
			}),
		};
	}

	#messagesInput(taskId: string): AgentInputMessage {
		const pending = this.#require(taskId).messages.filter((message) => message.deliveredAt == null);
		this.#markMessagesDelivered(taskId);
		return {
			kind: "task_message",
			text: JSON.stringify({ task_id: taskId, messages: pending.map(toMessageJson) }),
		};
	}

	#markMessagesDelivered(taskId: string, ids?: ReadonlySet<string>): Task {
		const deliveredAt = this.#timestamp();
		const task = this.#require(taskId);
		return this.#update(taskId, {
			messages: task.messages.map((message) =>
				message.deliveredAt == null && (ids === undefined || ids.has(message.id))
					? withDeliveredAt(message, deliveredAt)
					: message,
			),
		});
	}

	#fail(taskId: string, reason: string): void {
		const task = this.#require(taskId);
		if (isTerminalStatus(task.status)) return;
		const report: TaskReport = {
			seq: task.reports.length + 1,
			kind: "failure",
			summary: reason,
			artifacts: [],
			reportedAt: this.#timestamp(),
			deliveredAt: null,
		};
		this.#update(taskId, { reports: [...task.reports, report], status: "failed", outcome: reason });
		this.#deliver(taskId, report);
	}

	#deliver(taskId: string, report: TaskReport): void {
		// 受付停止後は配送せず未配送のまま残し、次回起動時の再配送に任せる。
		if (!this.#accepting) return;
		const task = this.#require(taskId);
		const event: LunaEvent = {
			id: this.dependencies.createId(),
			type: TASK_REPORTED_EVENT_TYPE,
			source: TASK_EVENT_SOURCE,
			subject: task.id,
			occurredAt: this.#timestamp(),
			// 結果を受け取る実行は新しいセッションのことがあるため、結果をどう扱うかを含む依頼文も届ける。
			data: {
				task: summarizeTask(task),
				instructions: task.instructions,
				report: toReportJson(report),
			},
		};
		const delivery = this.dependencies.delivery.deliver(task.origin, event).then(
			(outcome) => {
				if (outcome === "rejected") {
					this.dependencies.logger
						.child({ taskId })
						.warn("task.delivery_rejected", { reportSeq: report.seq });
					return;
				}
				const latest = this.#require(taskId);
				const deliveredAt = this.#timestamp();
				this.#update(taskId, {
					reports: latest.reports.map((candidate) =>
						candidate.seq === report.seq ? withDeliveredAt(candidate, deliveredAt) : candidate,
					),
				});
			},
			(error: unknown) => {
				this.dependencies.logger
					.child({ taskId })
					.error("task.delivery_failed", { error, reportSeq: report.seq });
			},
		);
		this.#track(delivery);
	}

	#stop(run: ActiveRun): void {
		const opened = run.opened;
		if (opened === undefined) return;
		void this.dependencies.releaseTools(opened.ownerId).catch((error: unknown) => {
			this.dependencies.logger.error("task.tools_release_failed", { error });
		});
		void opened.session.abort().catch((error: unknown) => {
			this.dependencies.logger.warn("task.abort_failed", { error });
		});
	}

	async #closeSession(opened: OpenedAgentSession): Promise<void> {
		await this.dependencies.releaseTools(opened.ownerId).catch((error: unknown) => {
			this.dependencies.logger.error("task.tools_release_failed", { error });
		});
		await opened.session.close().catch((error: unknown) => {
			this.dependencies.logger.error("task.session_close_failed", { error });
		});
	}

	#openTaskFor(origin: ToolOrigin, taskId: string): Task {
		const task = this.#tasks.get(taskId);
		const viewer: TaskViewer | undefined =
			origin.kind === "conversation"
				? { kind: "conversation", sessionKey: origin.session.key }
				: origin.kind === "event"
					? { kind: "event" }
					: undefined;
		if (task === undefined || viewer === undefined || !isVisibleTo(task, viewer)) {
			throw new TaskError(`Task ${taskId} is not available here`);
		}
		if (isTerminalStatus(task.status)) {
			throw new TaskError(`Task ${taskId} is already ${task.status}`);
		}
		return task;
	}

	#update(taskId: string, patch: Partial<Omit<Task, "id" | "version">>): Task {
		const task: Task = { ...this.#require(taskId), ...patch, updatedAt: this.#timestamp() };
		this.#tasks.set(taskId, task);
		const previous = this.#writes.get(taskId) ?? Promise.resolve();
		const write = previous.then(async () => {
			const latest = this.#tasks.get(taskId);
			if (latest === undefined) return;
			await this.dependencies.store.save(latest).catch((error: unknown) => {
				this.dependencies.logger.child({ taskId }).error("task.save_failed", { error });
			});
		});
		this.#writes.set(taskId, write);
		void write.then(() => {
			if (this.#writes.get(taskId) === write) this.#writes.delete(taskId);
		});
		return task;
	}

	async #persist(taskId: string): Promise<void> {
		if (!this.#writes.has(taskId)) this.#update(taskId, {});
		await this.#writes.get(taskId);
	}

	#require(taskId: string): Task {
		const task = this.#tasks.get(taskId);
		if (task === undefined) throw new TaskError(`Unknown task ${taskId}`);
		return task;
	}

	#track(promise: Promise<void>): void {
		this.#background.add(promise);
		void promise.finally(() => this.#background.delete(promise));
	}

	#timestamp(): string {
		return this.dependencies.now().toISOString();
	}
}

const STATUS_AFTER_REPORT: Readonly<Record<TaskReportKind, TaskStatus | undefined>> = {
	progress: undefined,
	milestone: undefined,
	question: "waiting_input",
	result: "completed",
	failure: "failed",
};

function statusAfterReport(status: TaskStatus, kind: TaskReportKind): TaskStatus {
	return STATUS_AFTER_REPORT[kind] ?? status;
}

// cancelや停止は別の非同期処理から書き換えるため、await後に改めて読む。
function isStopped(run: ActiveRun): boolean {
	return run.stopReason !== undefined;
}

function withDeliveredAt<Item extends { deliveredAt: string | null }>(
	item: Item,
	deliveredAt: string,
): Item {
	return { ...item, deliveredAt };
}

function toReportJson(report: TaskReport): JsonObject {
	return {
		seq: report.seq,
		kind: report.kind,
		summary: report.summary,
		artifacts: report.artifacts,
		reported_at: report.reportedAt,
	};
}

function toMessageJson(message: TaskMessage): JsonObject {
	return { id: message.id, text: message.text, received_at: message.receivedAt };
}
