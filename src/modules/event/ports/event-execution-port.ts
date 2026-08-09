import type { LunaEvent } from "../domain/luna-event";

export type EventExecutionResult =
  | Readonly<{ status: "completed" }>
  | Readonly<{ error: unknown; status: "failed" }>;

export interface EventExecutionPort {
  execute(event: LunaEvent, afterTurnStarted?: () => Promise<void>): Promise<EventExecutionResult>;
}
