import { z } from "zod";

import type { ConversationSession } from "../../conversation/domain/conversation-session";
import type { LunaEvent } from "../../event/domain/luna-event";
import { ASSIST_REQUESTED_EVENT_TYPE, HOME_ASSISTANT_EVENT_SOURCE } from "./home-assistant-event";

export const assistRequestSchema = z.strictObject({
	text: z.string().min(1),
	language: z.string(),
	conversation_id: z.string().min(1).max(128),
	device_id: z.string().min(1).nullable(),
	satellite_id: z.string().min(1).nullable(),
	device_name: z.string().nullable(),
	area_name: z.string().nullable(),
	user_name: z.string().nullable(),
});

export type AssistRequest = z.infer<typeof assistRequestSchema>;

export function createAssistRequestedEvent(
	request: AssistRequest,
	id: string,
	occurredAt: Date,
): LunaEvent {
	return {
		id,
		type: ASSIST_REQUESTED_EVENT_TYPE,
		source: HOME_ASSISTANT_EVENT_SOURCE,
		occurredAt: occurredAt.toISOString(),
		data: request,
	};
}

export function createAssistSession(request: AssistRequest): ConversationSession {
	if (request.device_id != null) {
		return {
			key: `home_assistant:assist:device:${request.device_id}`,
			source: HOME_ASSISTANT_EVENT_SOURCE,
			context: {
				device_id: request.device_id,
				device_name: request.device_name,
				area_name: request.area_name,
			},
		};
	}
	return {
		key: `home_assistant:assist:conversation:${request.conversation_id}`,
		source: HOME_ASSISTANT_EVENT_SOURCE,
		context: { conversation_id: request.conversation_id },
	};
}
