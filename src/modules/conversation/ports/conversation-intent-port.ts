import type { AgentInputMessage } from "../../agent/ports/outbound/agent-session-port";
import type { LunaEvent } from "../../event/domain/luna-event";

export interface ConversationIntentPort {
	match(events: readonly LunaEvent[]): readonly AgentInputMessage[];
}
