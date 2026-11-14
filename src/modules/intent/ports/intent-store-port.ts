import type { IntentFireStates, StandingIntent } from "../domain/standing-intent";

export interface IntentStorePort {
	readIntents(): readonly StandingIntent[];
	readStates(): IntentFireStates;
	writeStates(states: IntentFireStates): void;
}
