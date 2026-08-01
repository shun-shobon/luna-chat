export interface AutomationTimerHandle {
  cancel(): void;
}

export interface AutomationClockPort {
  now(): Date;
  setTimer(delayMs: number, callback: () => void): AutomationTimerHandle;
}

export interface AutomationRandomPort {
  integerInclusive(minimum: number, maximum: number): number;
}
