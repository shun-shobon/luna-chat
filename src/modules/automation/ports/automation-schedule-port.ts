export interface ScheduledAutomationJob {
	nextRunAt(): Date | null;
	stop(): void;
}

export interface AutomationScheduleTimerPort {
	schedule(cronTime: Date | string, onTick: () => Promise<void>): ScheduledAutomationJob;
}

export interface AutomationScheduleWatcherPort {
	close(): Promise<void>;
	start(input: { onChange: () => void; onError: (error: unknown) => void }): Promise<void>;
}
