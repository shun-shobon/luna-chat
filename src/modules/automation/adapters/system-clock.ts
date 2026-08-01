import type {
  AutomationClockPort,
  AutomationRandomPort,
  AutomationTimerHandle,
} from "../ports/automation-clock-port";

const MAXIMUM_TIMEOUT_MS = 2_147_483_647;

export class SystemAutomationClock implements AutomationClockPort {
  now(): Date {
    return new Date();
  }

  setTimer(delayMs: number, callback: () => void): AutomationTimerHandle {
    const startedAt = Date.now();
    let timeout: NodeJS.Timeout | undefined;

    const scheduleChunk = (): void => {
      const remainingMs = delayMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        timeout = setTimeout(callback, 0);
        return;
      }
      timeout = setTimeout(scheduleChunk, Math.min(remainingMs, MAXIMUM_TIMEOUT_MS));
    };
    scheduleChunk();

    return {
      cancel: () => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      },
    };
  }
}

export class SystemAutomationRandom implements AutomationRandomPort {
  integerInclusive(minimum: number, maximum: number): number {
    return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
  }
}
