import type { JsonObject } from "../../../shared/json";
import type {
	AgentRuntimePort,
	AgentThreadInput,
} from "../../agent/ports/outbound/agent-runtime-port";
import { requiresEffectFollowUp } from "../../effect/domain/effect";
import type { EffectOrigin } from "../../effect/domain/effect";
import type { EffectBatchPort } from "../../effect/ports/effect-batch-port";
import type { EffectOutputContract } from "../../effect/ports/effect-output-contract";
import type { LunaEvent } from "../../event/domain/luna-event";
import type { LoggerPort } from "../../observability/ports/logger-port";
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
const MAX_OUTPUT_ERRORS = 2;
const SNAPSHOT_RECENT_MS = 86_400_000;
const SNAPSHOT_LIMIT = 20;

type TaskSession = Extract<TaskOrigin, { kind: "conversation" }>["session"];

type TaskServiceDependencies = Readonly<{
	agent: AgentRuntimePort;
	createId: () => string;
	createThreadInput: () => Promise<AgentThreadInput & { executionOwnerId: string }>;
	delivery: TaskDeliveryPort;
	effectOutput: EffectOutputContract;
	effects: EffectBatchPort;
	isPrivateSession: (session: TaskSession) => boolean;
	logger: LoggerPort;
	maxConcurrent: number;
	now: () => Date;
	store: TaskStorePort;
}>;

type WorkerThread = Readonly<{ id: string; ownerId: string }>;

type ActiveRun = {
	readonly generation: number;
	nudged: boolean;
	outputErrors: number;
	steering: boolean;
	stopReason: "cancelled" | "shutdown" | undefined;
	thread: WorkerThread | undefined;
	turnId: string | undefined;
};

class TaskError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskError";
	}
}

export class TaskService {
	readonly #background = new Set<Promise<void>>();
	readonly #parked = new Map<string, WorkerThread>();
	readonly #runs = new Map<string, ActiveRun>();
	readonly #tasks = new Map<string, Task>();
	readonly #writes = new Map<string, Promise<void>>();
	#accepting = false;
	#generation = 0;

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
		await Promise.allSettled(parked.map(async (thread) => await this.#closeThread(thread)));
		while (this.#background.size > 0) await Promise.allSettled(this.#background);
		while (this.#writes.size > 0) await Promise.allSettled(this.#writes.values());
	}

	connectionLost(): void {
		this.#generation += 1;
		this.#parked.clear();
		// 旧接続のturnは失敗するが、system.waitは接続と無関係に続き実行枠を占有するため打ち切る。
		for (const run of this.#runs.values()) {
			if (run.thread !== undefined) void this.#releaseEffects(run.thread.ownerId);
		}
	}

	async create(
		origin: EffectOrigin,
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

	async message(origin: EffectOrigin, taskId: string, text: string): Promise<TaskStatus> {
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
		if (run !== undefined && !this.#parked.has(taskId)) this.#kickSteer(taskId, run);
		else if (task.status === "waiting_input") {
			this.#update(taskId, { status: "queued" });
			this.#pump();
		}
		await this.#persist(taskId);
		return this.#require(taskId).status;
	}

	async cancel(origin: EffectOrigin, taskId: string, reason: string | null): Promise<TaskStatus> {
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
			this.#track(this.#closeThread(parked));
		}
		await this.#persist(taskId);
		return "cancelled";
	}

	async report(
		origin: EffectOrigin,
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
		const nowMs = this.dependencies.now().getTime();
		return [...this.#tasks.values()]
			.filter(
				(task) =>
					isVisibleTo(task, viewer) &&
					(!isTerminalStatus(task.status) ||
						nowMs - Date.parse(task.updatedAt) < SNAPSHOT_RECENT_MS),
			)
			.toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
			.slice(0, SNAPSHOT_LIMIT)
			.map(summarizeTask);
	}

	#pump(): void {
		if (!this.#accepting) return;
		const queued = [...this.#tasks.values()]
			.filter((task) => task.status === "queued" && !this.#runs.has(task.id))
			.toSorted((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
		for (const task of queued) {
			if (this.#runs.size >= this.dependencies.maxConcurrent) return;
			const run: ActiveRun = {
				generation: this.#generation,
				nudged: false,
				outputErrors: 0,
				steering: false,
				stopReason: undefined,
				thread: this.#parked.get(task.id),
				turnId: undefined,
			};
			this.#parked.delete(task.id);
			this.#runs.set(task.id, run);
			this.#track(this.#drive(task.id, run));
		}
	}

	async #drive(taskId: string, run: ActiveRun): Promise<void> {
		const resumed = run.thread !== undefined;
		try {
			const task = this.#update(taskId, {
				status: "running",
				attempts: resumed ? this.#require(taskId).attempts : this.#require(taskId).attempts + 1,
			});
			if (task.attempts > MAX_ATTEMPTS) {
				this.#fail(taskId, `Task was interrupted ${String(MAX_ATTEMPTS)} times.`);
				return;
			}
			const thread = run.thread ?? (await this.#openThread(run));
			let input: string | undefined = resumed
				? this.#messagesInput(taskId)
				: this.#taskInput(taskId);
			while (input !== undefined) input = await this.#runTurn(taskId, run, thread, input);
		} catch (error: unknown) {
			if (isStopped(run)) return;
			if (run.generation !== this.#generation) {
				this.dependencies.logger.log("warn", "task.run_interrupted", { taskId }, { error });
				if (this.#require(taskId).status === "running") this.#update(taskId, { status: "queued" });
				return;
			}
			this.dependencies.logger.log("error", "task.run_failed", { taskId }, { error });
			this.#fail(taskId, error instanceof Error ? error.message : String(error));
		} finally {
			this.#runs.delete(taskId);
			// 旧接続のthreadは新しいapp-serverでは閉じられないため、EventExecutorと同じく残す。
			if (run.thread !== undefined && run.generation === this.#generation) {
				await this.#closeThread(run.thread);
			}
			this.#pump();
		}
	}

	// 次のturnの入力を返す。undefinedならこのrunを終える。
	async #runTurn(
		taskId: string,
		run: ActiveRun,
		thread: WorkerThread,
		input: string,
	): Promise<string | undefined> {
		this.#assertCurrent(run);
		const started = await this.dependencies.agent.startTurn(thread.id, {
			input,
			outputSchema: this.dependencies.effectOutput.jsonSchema,
		});
		run.turnId = started.turnId;
		if (isStopped(run)) this.#stop(run);
		this.#kickSteer(taskId, run);
		const result = await started.completion;
		run.turnId = undefined;
		if (isStopped(run)) return undefined;
		if (result.status !== "completed") {
			throw new Error(result.errorMessage ?? `Task turn ${result.status}`);
		}
		let output: ReturnType<EffectOutputContract["parse"]>;
		try {
			output = this.dependencies.effectOutput.parse(result.outputText);
		} catch (error: unknown) {
			if (run.outputErrors >= MAX_OUTPUT_ERRORS) throw error;
			run.outputErrors += 1;
			return JSON.stringify({
				source: "output_error",
				task_id: taskId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		run.outputErrors = 0;
		const results = await this.dependencies.effects.execute(output.effects, {
			ownerId: thread.ownerId,
			origin: { kind: "task", taskId },
		});
		await this.#releaseEffects(thread.ownerId);
		if (isStopped(run)) return undefined;
		const current = this.#require(taskId);
		if (isTerminalStatus(current.status)) return undefined;
		if (current.status === "running" && requiresEffectFollowUp(results)) {
			return JSON.stringify({ source: "effect_results", results });
		}
		if (current.messages.some((message) => message.deliveredAt == null)) {
			this.#update(taskId, { status: "running" });
			return this.#messagesInput(taskId);
		}
		if (current.status === "waiting_input") {
			if (run.generation === this.#generation) {
				this.#parked.set(taskId, thread);
				run.thread = undefined;
			}
			return undefined;
		}
		if (!run.nudged) {
			run.nudged = true;
			return JSON.stringify({ source: "task_check", task_id: taskId });
		}
		this.#fail(taskId, "Worker ended without a result, question, or failure report.");
		return undefined;
	}

	async #openThread(run: ActiveRun): Promise<WorkerThread> {
		const input = await this.dependencies.createThreadInput();
		this.#assertCurrent(run);
		const id = await this.dependencies.agent.openThread(input);
		run.thread = { id, ownerId: input.executionOwnerId };
		this.#assertCurrent(run);
		return run.thread;
	}

	#assertCurrent(run: ActiveRun): void {
		if (run.generation !== this.#generation) {
			throw new Error("Codex connection was lost during the task");
		}
	}

	#taskInput(taskId: string): string {
		const task = this.#markMessagesDelivered(taskId);
		return JSON.stringify({
			source: "task",
			task: {
				id: task.id,
				title: task.title,
				instructions: task.instructions,
				origin: describeOrigin(task.origin),
				created_at: task.createdAt,
				attempt: task.attempts,
				previous_reports: task.reports.map(toReportJson),
			},
			messages: task.messages.map(toMessageJson),
		});
	}

	#messagesInput(taskId: string): string {
		const pending = this.#require(taskId).messages.filter((message) => message.deliveredAt == null);
		this.#markMessagesDelivered(taskId);
		return JSON.stringify({
			source: "task_messages",
			task_id: taskId,
			messages: pending.map(toMessageJson),
		});
	}

	#kickSteer(taskId: string, run: ActiveRun): void {
		const turnId = run.turnId;
		const thread = run.thread;
		if (turnId === undefined || thread === undefined || run.steering) return;
		const pending = this.#require(taskId).messages.filter((message) => message.deliveredAt == null);
		if (pending.length === 0) return;
		run.steering = true;
		const input = JSON.stringify({
			source: "task_messages",
			task_id: taskId,
			messages: pending.map(toMessageJson),
		});
		void this.dependencies.agent.steerTurn(thread.id, turnId, input).then(
			() => {
				run.steering = false;
				this.#markMessagesDelivered(taskId, new Set(pending.map((message) => message.id)));
				if (run.turnId === turnId) this.#kickSteer(taskId, run);
			},
			(error: unknown) => {
				// 同じturnへ再送しても拒否が続くため、未配送のmessageはchain終了後の次turnで渡す。
				run.steering = false;
				this.dependencies.logger.log("info", "task.steer_skipped", { taskId }, { error });
			},
		);
	}

	#markMessagesDelivered(taskId: string, ids?: ReadonlySet<string>): Task {
		const deliveredAt = this.#timestamp();
		const task = this.#require(taskId);
		return this.#update(taskId, {
			messages: task.messages.map((message) =>
				message.deliveredAt == null && (ids === undefined || ids.has(message.id))
					? { ...message, deliveredAt }
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
			data: { task: summarizeTask(task), report: toReportJson(report) },
		};
		const delivery = this.dependencies.delivery.deliver(task.origin, event).then(
			(outcome) => {
				if (outcome === "rejected") {
					this.dependencies.logger.log(
						"warn",
						"task.delivery_rejected",
						{ taskId },
						{ reportSeq: report.seq },
					);
					return;
				}
				const latest = this.#require(taskId);
				const deliveredAt = this.#timestamp();
				this.#update(taskId, {
					reports: latest.reports.map((candidate) =>
						candidate.seq === report.seq ? { ...candidate, deliveredAt } : candidate,
					),
				});
			},
			(error: unknown) => {
				this.dependencies.logger.log(
					"error",
					"task.delivery_failed",
					{ taskId },
					{ error, reportSeq: report.seq },
				);
			},
		);
		this.#track(delivery);
	}

	#stop(run: ActiveRun): void {
		const thread = run.thread;
		if (thread === undefined) return;
		void this.#releaseEffects(thread.ownerId);
		const turnId = run.turnId;
		if (turnId === undefined) return;
		void this.dependencies.agent.interruptTurn(thread.id, turnId).catch((error: unknown) => {
			this.dependencies.logger.log("warn", "task.interrupt_failed", {}, { error });
		});
	}

	async #closeThread(thread: WorkerThread): Promise<void> {
		await this.#releaseEffects(thread.ownerId);
		await this.dependencies.agent.archiveThread(thread.id).catch((error: unknown) => {
			this.dependencies.logger.log(
				"error",
				"task.thread_archive_failed",
				{ threadId: thread.id },
				{ error },
			);
		});
	}

	async #releaseEffects(ownerId: string): Promise<void> {
		await this.dependencies.effects.release(ownerId).catch((error: unknown) => {
			this.dependencies.logger.log("error", "task.effects_release_failed", {}, { error });
		});
	}

	#openTaskFor(origin: EffectOrigin, taskId: string): Task {
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
				this.dependencies.logger.log("error", "task.save_failed", { taskId }, { error });
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
