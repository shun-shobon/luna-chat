import type { LunaEvent } from "../../event/domain/luna-event";
import type { ConversationSession } from "../domain/conversation-session";

export interface ConversationHistoryPort {
  fetchBefore(
    session: ConversationSession,
    beforeEvent: LunaEvent,
    limit: number,
  ): Promise<readonly LunaEvent[]>;
}
