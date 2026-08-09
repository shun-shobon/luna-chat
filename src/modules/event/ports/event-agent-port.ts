import type { LunaEvent } from "../domain/luna-event";

export type StartedEventTurn = Readonly<{ completion: Promise<void> }>;

export interface EventAgentPort {
  archiveThread(threadId: string): Promise<void>;
  openEventThread(): Promise<string>;
  startEventTurn(threadId: string, event: LunaEvent): Promise<StartedEventTurn>;
}
