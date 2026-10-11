export interface AutomationTimerHandle {
	cancel(): void;
}

export interface AutomationClockPort {
	now(): Date;
	setTimer(delayMs: number, callback: () => void): AutomationTimerHandle;
}
