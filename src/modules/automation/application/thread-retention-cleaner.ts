import type { AutomationAgentPort } from "../ports/automation-agent-port";
import type { AutomationClockPort, AutomationTimerHandle } from "../ports/automation-clock-port";
import type { AutomationLogPort } from "../ports/automation-log-port";

import { ActiveExecutionSet } from "./active-execution-set";

export class ThreadRetentionCleaner {
  readonly #agent: AutomationAgentPort;
  readonly #clock: AutomationClockPort;
  readonly #cleanupIntervalMs: number;
  readonly #executions: ActiveExecutionSet;
  readonly #logger: AutomationLogPort;
  readonly #retentionMs: number;

  #accepting = false;
  #timer: AutomationTimerHandle | undefined;

  constructor(input: {
    agent: AutomationAgentPort;
    cleanupIntervalMs: number;
    clock: AutomationClockPort;
    executions?: ActiveExecutionSet;
    logger: AutomationLogPort;
    retentionMs: number;
  }) {
    this.#agent = input.agent;
    this.#cleanupIntervalMs = input.cleanupIntervalMs;
    this.#clock = input.clock;
    this.#executions = input.executions ?? new ActiveExecutionSet();
    this.#logger = input.logger;
    this.#retentionMs = input.retentionMs;
  }

  async start(): Promise<void> {
    if (this.#accepting) {
      return;
    }
    this.#accepting = true;
    await this.#runCleanup();
    this.#scheduleNext();
  }

  stopIntake(): void {
    this.#accepting = false;
    this.#timer?.cancel();
    this.#timer = undefined;
  }

  async drain(): Promise<void> {
    await this.#executions.drain();
  }

  #scheduleNext(): void {
    if (!this.#accepting) {
      return;
    }

    this.#timer = this.#clock.setTimer(this.#cleanupIntervalMs, () => {
      this.#timer = undefined;
      const cleanup = this.#runCleanup().finally(() => {
        this.#scheduleNext();
      });
      this.#executions.track(cleanup);
    });
  }

  async #runCleanup(): Promise<void> {
    const nowMs = this.#clock.now().getTime();
    let cursor: string | undefined;

    try {
      do {
        const page = await this.#agent.listArchivedThreads({ cursor });
        const expiredThreadIds: string[] = [];

        for (const thread of page.data) {
          if (thread.updatedAt === undefined) {
            this.#logger.warn("automation.thread_retention.updated_at_missing", {
              threadId: thread.id,
            });
            continue;
          }
          if (nowMs - thread.updatedAt * 1_000 > this.#retentionMs) {
            expiredThreadIds.push(thread.id);
          }
        }

        await Promise.all(
          expiredThreadIds.map(async (threadId) => {
            await this.#agent.deleteArchivedThread(threadId).catch((error: unknown) => {
              this.#logger.error("automation.thread_retention.delete_failed", {
                error,
                threadId,
              });
            });
          }),
        );
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    } catch (error: unknown) {
      this.#logger.error("automation.thread_retention.list_failed", { error });
    }
  }
}
