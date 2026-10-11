import type {
	AutomationClockPort,
	AutomationRandomPort,
	AutomationTimerHandle,
} from "../ports/automation-clock-port";

export class SystemAutomationClock implements AutomationClockPort {
	now(): Date {
		return new Date();
	}

	setTimer(delayMs: number, callback: () => void): AutomationTimerHandle {
		const timeout = setTimeout(callback, delayMs);
		return { cancel: () => clearTimeout(timeout) };
	}
}

export class SystemAutomationRandom implements AutomationRandomPort {
	integerInclusive(minimum: number, maximum: number): number {
		return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
	}
}
