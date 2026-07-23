export interface ScheduledAutomationJob {
  stop(): void;
}

export interface AutomationScheduleTimerPort {
  scheduleOneShot(at: Date, onTick: () => Promise<void>): ScheduledAutomationJob;
  scheduleRecurring(cron: string, onTick: () => Promise<void>): ScheduledAutomationJob;
}

export interface AutomationScheduleWatcherPort {
  close(): Promise<void>;
  start(input: { onChange: () => void; onError: (error: unknown) => void }): Promise<void>;
}
