import type { JsonObject } from "../../../shared/json";
import type { ConversationSession } from "../domain/conversation-session";

export interface ConversationTaskBoardPort {
	listFor(session: ConversationSession): readonly JsonObject[];
}
