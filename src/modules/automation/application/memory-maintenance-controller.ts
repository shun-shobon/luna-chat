import type { AutomationClockPort } from "../ports/automation-clock-port";
import type {
  AutomationScheduleTimerPort,
  ScheduledAutomationJob,
} from "../ports/automation-schedule-port";

import { ActiveExecutionSet } from "./active-execution-set";
import type { AutomationExecutionPort } from "./automation-executor";

export class MemoryMaintenanceController {
  readonly #clock: AutomationClockPort;
  readonly #cron: string;
  readonly #enabled: boolean;
  readonly #executions: ActiveExecutionSet;
  readonly #executor: AutomationExecutionPort;
  readonly #scheduleTimer: AutomationScheduleTimerPort;

  #accepting = false;
  #timer: ScheduledAutomationJob | undefined;

  constructor(input: {
    clock: AutomationClockPort;
    cron: string;
    enabled: boolean;
    executions?: ActiveExecutionSet;
    executor: AutomationExecutionPort;
    scheduleTimer: AutomationScheduleTimerPort;
  }) {
    this.#clock = input.clock;
    this.#cron = input.cron;
    this.#enabled = input.enabled;
    this.#executions = input.executions ?? new ActiveExecutionSet();
    this.#executor = input.executor;
    this.#scheduleTimer = input.scheduleTimer;
  }

  start(): void {
    if (this.#accepting || !this.#enabled) {
      return;
    }
    this.#accepting = true;
    this.#timer = this.#scheduleTimer.scheduleRecurring(this.#cron, async () => {
      if (!this.#accepting) {
        return;
      }
      const execution = this.#executor
        .execute({
          date: formatLocalDate(this.#clock.now()),
          source: "memory_maintenance",
        })
        .then(() => undefined);
      this.#executions.track(execution);
      await execution;
    });
  }

  stopIntake(): void {
    this.#accepting = false;
    this.#timer?.stop();
    this.#timer = undefined;
  }

  async drain(): Promise<void> {
    await this.#executions.drain();
  }
}

function formatLocalDate(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error("Memory maintenance date must be valid");
  const localYear = date.getFullYear();
  if (localYear < 0 || localYear > 9_999) {
    throw new Error("Memory maintenance date year must fit YYYY");
  }
  const year = localYear.toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}
