import type { ConversationSession } from "../../conversation/domain/conversation-session";

export const HOME_ASSISTANT_EVENT_SOURCE = "home_assistant";
export const STATE_CHANGED_EVENT_TYPE = "home_assistant.state_changed.v1";
export const ASSIST_REQUESTED_EVENT_TYPE = "home_assistant.assist.requested.v1";

export const STATE_CHANGES_SESSION: ConversationSession = {
	key: "home_assistant:state_changes",
	source: HOME_ASSISTANT_EVENT_SOURCE,
	context: { kind: "state_changes" },
};

export function isAssistSession(session: ConversationSession): boolean {
	return session.key.startsWith("home_assistant:assist:");
}
