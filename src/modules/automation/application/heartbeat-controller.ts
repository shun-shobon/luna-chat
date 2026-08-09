import type {
  AutomationClockPort,
  AutomationRandomPort,
  AutomationTimerHandle,
} from "../ports/automation-clock-port";
import type { AutomationLogPort } from "../ports/automation-log-port";
import type { AutomationWorkspacePort } from "../ports/automation-workspace-port";

import { ActiveExecutionSet } from "./active-execution-set";

export class HeartbeatController {
  readonly #clock: AutomationClockPort;
  readonly #enabled: boolean;
  readonly #executions: ActiveExecutionSet;
  readonly #createEventId: () => string;
  readonly #executor: EventExecutionPort;
  readonly #logger: AutomationLogPort;
  readonly #maximumIntervalMs: number;
  readonly #minimumIntervalMs: number;
  readonly #random: AutomationRandomPort;
  readonly #workspace: AutomationWorkspacePort;

  #accepting = false;
  #timer: AutomationTimerHandle | undefined;

  constructor(input: {
    clock: AutomationClockPort;
    createEventId?: (() => string) | undefined;
    enabled: boolean;
    executions?: ActiveExecutionSet;
    executor: EventExecutionPort;
    logger: AutomationLogPort;
    maximumIntervalMs: number;
    minimumIntervalMs: number;
    random: AutomationRandomPort;
    workspace: AutomationWorkspacePort;
  }) {
    this.#clock = input.clock;
    this.#createEventId = input.createEventId ?? randomUUID;
    this.#enabled = input.enabled;
    this.#executions = input.executions ?? new ActiveExecutionSet();
    this.#executor = input.executor;
    this.#logger = input.logger;
    this.#maximumIntervalMs = input.maximumIntervalMs;
    this.#minimumIntervalMs = input.minimumIntervalMs;
    this.#random = input.random;
    this.#workspace = input.workspace;
  }

  start(): void {
    if (this.#accepting || !this.#enabled) {
      return;
    }
    this.#accepting = true;
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

    const delayMs = this.#random.integerInclusive(this.#minimumIntervalMs, this.#maximumIntervalMs);
    this.#timer = this.#clock.setTimer(delayMs, () => {
      this.#timer = undefined;
      const execution = this.#runOnce().finally(() => {
        this.#scheduleNext();
      });
      this.#executions.track(execution);
    });
  }

  async #runOnce(): Promise<void> {
    let checklist: string;
    try {
      checklist = await this.#workspace.readHeartbeatChecklist();
    } catch (error: unknown) {
      this.#logger.error("automation.heartbeat.checklist_read_failed", { error });
      return;
    }

    await this.#executor.execute({
      id: this.#createEventId(),
      type: "system.heartbeat.fired.v1",
      source: "system/heartbeat",
      occurredAt: this.#clock.now().toISOString(),
      data: { checklist },
    });
  }
}
import { randomUUID } from "node:crypto";

import type { EventExecutionPort } from "../../event/ports/event-execution-port";
