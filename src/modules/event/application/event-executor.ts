import type { AgentInputMessage } from "../../agent/ports/outbound/agent-session-port";
import type { LoggerPort } from "../../observability/ports/logger-port";
import { describeRunFailure } from "../../tool/ports/agent-session-factory-port";
import type {
	OpenAgentSession,
	OpenedAgentSession,
} from "../../tool/ports/agent-session-factory-port";
import type { LunaEvent } from "../domain/luna-event";
import type {
	EventExecutionHooks,
	EventExecutionPort,
	EventExecutionResult,
	EventExecutionStatus,
} from "../ports/event-execution-port";
import { toEventMessage } from "../ports/event-message";
import type { EventTaskBoardPort } from "../ports/event-task-board-port";

type RunningExecution = {
	readonly event: LunaEvent;
	readonly startedAt: string;
	opened: OpenedAgentSession | undefined;
};

export class EventExecutor implements EventExecutionPort {
	readonly #running = new Set<RunningExecution>();
	#stoppingBackground = false;

	public constructor(
		private readonly dependencies: Readonly<{
			logger: LoggerPort;
			now: () => Date;
			openSession: OpenAgentSession;
			releaseTools: (ownerId: string) => Promise<void>;
			tasks: EventTaskBoardPort;
		}>,
	) {}

	public snapshot(): readonly EventExecutionStatus[] {
		return [...this.#running].map((running) => {
			const status = running.opened?.session.status();
			return {
				eventId: running.event.id,
				eventSource: running.event.source,
				eventType: running.event.type,
				phase:
					status === undefined || status.phase === "idle" || status.phase === "closed"
						? running.opened === undefined
							? "opening"
							: "running"
						: status.phase,
				startedAt: running.startedAt,
				subject: running.event.subject ?? null,
				sessionId: status?.id ?? null,
			};
		});
	}

	// シャットダウンで、バックグラウンド実行の終了を待たずに閉じられるようにする。
	public async stopBackground(): Promise<void> {
		this.#stoppingBackground = true;
		await Promise.all(
			[...this.#running].map(async (running) => await running.opened?.session.stopBackground()),
		);
	}

	public async execute(
		event: LunaEvent,
		hooks?: EventExecutionHooks,
	): Promise<EventExecutionResult> {
		const running: RunningExecution = {
			event,
			startedAt: this.dependencies.now().toISOString(),
			opened: undefined,
		};
		this.#running.add(running);
		const logger = this.dependencies.logger.child({ eventId: event.id });
		logger.info(
			"event.execution_started",
			{ eventSource: event.source, eventType: event.type, subject: event.subject },
			event,
		);

		let result: EventExecutionResult;
		let firstRunSettled = false;
		const settleFirstRun = (first: EventExecutionResult): void => {
			if (firstRunSettled) return;
			firstRunSettled = true;
			hooks?.afterFirstRun?.(first);
		};
		try {
			const opened = await this.dependencies.openSession({
				kind: "event",
				eventId: event.id,
				eventType: event.type,
			});
			running.opened = opened;
			const run = opened.session.run([toEventMessage(event), this.#taskBoardMessage()]);
			try {
				await hooks?.afterRunStarted?.();
			} catch (error: unknown) {
				await opened.session.abort();
				await run;
				throw error;
			}
			const completed = await run;
			if (completed.status !== "completed") throw new Error(describeRunFailure(completed));
			settleFirstRun({ status: "completed" });
			while (!this.#stoppingBackground && (await opened.session.waitForBackground())) {
				const continued = await opened.session.run([this.#taskBoardMessage()]);
				if (continued.status !== "completed") throw new Error(describeRunFailure(continued));
			}
			result = { status: "completed" };
			logger.info("event.execution_completed", { sessionId: opened.session.id });
		} catch (error: unknown) {
			logger.error("event.execution_failed", {
				error,
				eventSource: event.source,
				eventType: event.type,
			});
			result = { error, status: "failed" };
			settleFirstRun(result);
		} finally {
			this.#running.delete(running);
			if (running.opened !== undefined) await this.#close(running.opened, logger);
		}
		return result;
	}

	#taskBoardMessage(): AgentInputMessage {
		return { kind: "task_board", text: JSON.stringify(this.dependencies.tasks.listAll()) };
	}

	async #close(opened: OpenedAgentSession, logger: LoggerPort): Promise<void> {
		await this.dependencies.releaseTools(opened.ownerId).catch((error: unknown) => {
			logger.error("event.operation_failed", { error, operation: "tools/release" });
		});
		await opened.session.close().catch((error: unknown) => {
			logger.error("event.operation_failed", { error, operation: "session/close" });
		});
	}
}
