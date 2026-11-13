import type { AgentInputMessage } from "../../agent/ports/outbound/agent-session-port";
import type { LunaEvent } from "../domain/luna-event";

const MESSAGE_KIND_BY_EVENT_TYPE: Readonly<Record<string, string>> = {
	"discord.message.created.v1": "discord_message",
	"discord.conversation.delegated.v1": "delegated_conversation",
	"luna.task.reported.v1": "task_report",
	"system.heartbeat.fired.v1": "heartbeat",
	"system.schedule.fired.v1": "schedule",
	"system.memory_maintenance.fired.v1": "memory_maintenance",
};

export function toEventMessage(event: LunaEvent): AgentInputMessage {
	return {
		kind:
			MESSAGE_KIND_BY_EVENT_TYPE[event.type] ??
			(event.source === "http" ? "http_request" : "event"),
		text: JSON.stringify(event),
	};
}
