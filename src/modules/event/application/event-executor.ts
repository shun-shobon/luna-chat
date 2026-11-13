import type { LoggerPort } from "../../observability/ports/logger-port";
import { describeRunFailure } from "../../tool/ports/agent-session-factory-port";
import type {
	OpenAgentSession,
	OpenedAgentSession,
} from "../../tool/ports/agent-session-factory-port";
import type { LunaEvent } from "../domain/luna-event";
import type {
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

	public async execute(
		event: LunaEvent,
		afterRunStarted?: () => Promise<void>,
	): Promise<EventExecutionResult> {
		const running: RunningExecution = {
			event,
			startedAt: this.dependencies.now().toISOString(),
			opened: undefined,
		};
		this.#running.add(running);
		this.dependencies.logger.log(
			"info",
			"event.execution_started",
			{ eventId: event.id },
			{ eventSource: event.source, eventType: event.type, subject: event.subject },
			event,
		);

		let result: EventExecutionResult;
		try {
			const opened = await this.dependencies.openSession({
				kind: "event",
				eventId: event.id,
				eventType: event.type,
			});
			running.opened = opened;
			const run = opened.session.run([
				toEventMessage(event),
				{ kind: "task_board", text: JSON.stringify(this.dependencies.tasks.listAll()) },
			]);
			try {
				await afterRunStarted?.();
			} catch (error: unknown) {
				await opened.session.abort();
				await run;
				throw error;
			}
			const completed = await run;
			if (completed.status !== "completed") throw new Error(describeRunFailure(completed));
			result = { status: "completed" };
			this.dependencies.logger.log(
				"info",
				"event.execution_completed",
				{ eventId: event.id },
				{ sessionId: opened.session.id },
			);
		} catch (error: unknown) {
			this.dependencies.logger.log(
				"error",
				"event.execution_failed",
				{ eventId: event.id },
				{ error, eventSource: event.source, eventType: event.type },
			);
			result = { error, status: "failed" };
		} finally {
			this.#running.delete(running);
			if (running.opened !== undefined) await this.#close(running.opened);
		}
		return result;
	}

	async #close(opened: OpenedAgentSession): Promise<void> {
		await this.dependencies.releaseTools(opened.ownerId).catch((error: unknown) => {
			this.dependencies.logger.log(
				"error",
				"event.operation_failed",
				{},
				{ error, operation: "tools/release" },
			);
		});
		await opened.session.close().catch((error: unknown) => {
			this.dependencies.logger.log(
				"error",
				"event.operation_failed",
				{},
				{ error, operation: "session/close" },
			);
		});
	}
}
