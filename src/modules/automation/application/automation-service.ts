import type { WorkspaceSchedule } from "../../workspace/domain/workspace-schedule";

interface HeartbeatAutomationControl {
  drain(): Promise<void>;
  start(): void;
  stopIntake(): void;
}

interface ScheduleAutomationControl {
  drain(): Promise<void>;
  reloadSchedule(): Promise<void>;
  start(initialSchedule: WorkspaceSchedule): Promise<void>;
  stopIntake(): Promise<void>;
}

interface RetentionAutomationControl {
  drain(): Promise<void>;
  start(): Promise<void>;
  stopIntake(): void;
}

export class AutomationService {
  readonly #heartbeat: HeartbeatAutomationControl;
  readonly #retention: RetentionAutomationControl;
  readonly #schedule: ScheduleAutomationControl;
  #started = false;

  constructor(input: {
    heartbeat: HeartbeatAutomationControl;
    retention: RetentionAutomationControl;
    schedule: ScheduleAutomationControl;
  }) {
    this.#heartbeat = input.heartbeat;
    this.#retention = input.retention;
    this.#schedule = input.schedule;
  }

  async startAutomation(initialSchedule: WorkspaceSchedule): Promise<void> {
    if (this.#started) {
      return;
    }
    try {
      await this.#retention.start();
      await this.#schedule.start(initialSchedule);
      this.#heartbeat.start();
      this.#started = true;
    } catch (error: unknown) {
      await this.stopIntake();
      throw error;
    }
  }

  async reloadSchedule(): Promise<void> {
    await this.#schedule.reloadSchedule();
  }

  async stopIntake(): Promise<void> {
    this.#heartbeat.stopIntake();
    this.#retention.stopIntake();
    await this.#schedule.stopIntake();
  }

  async drain(): Promise<void> {
    await Promise.all([this.#heartbeat.drain(), this.#schedule.drain(), this.#retention.drain()]);
  }
}
