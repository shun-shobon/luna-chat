import { z } from "zod";

import type { ConversationSession } from "../../conversation/domain/conversation-session";
import type { LunaEvent } from "../../event/domain/luna-event";
import { conversationScopeKey, conversationScopeSchema } from "./conversation-scope";
import type { ConversationScope } from "./conversation-scope";
import { discordMessageSchema } from "./discord-message";
import type { DiscordMessage } from "./discord-message";

export const DISCORD_EVENT_SOURCE = "discord/main";
export const DISCORD_MESSAGE_CREATED_EVENT_TYPE = "discord.message.created.v1";
export const DISCORD_CONVERSATION_DELEGATED_EVENT_TYPE = "discord.conversation.delegated.v1";

export const discordMessageEventDataSchema = z.strictObject({
	scope: conversationScopeSchema,
	message: discordMessageSchema,
});

export const discordDelegatedEventDataSchema = z.strictObject({
	scope: conversationScopeSchema,
	brief: z.string().min(1),
});

export function createDiscordConversationSession(scope: ConversationScope): ConversationSession {
	return {
		key: `discord:${conversationScopeKey(scope)}`,
		source: DISCORD_EVENT_SOURCE,
		context: scope,
	};
}

export function createDiscordMessageEvent(
	session: ConversationSession,
	message: DiscordMessage,
): LunaEvent {
	return {
		id: message.id,
		type: DISCORD_MESSAGE_CREATED_EVENT_TYPE,
		source: DISCORD_EVENT_SOURCE,
		subject: session.key,
		occurredAt: message.timestamp,
		data: { scope: session.context, message },
	};
}

export function createDiscordDelegatedEvent(
	input: Readonly<{ id: string; scope: ConversationScope; brief: string; occurredAt: Date }>,
): LunaEvent {
	const session = createDiscordConversationSession(input.scope);
	return {
		id: input.id,
		type: DISCORD_CONVERSATION_DELEGATED_EVENT_TYPE,
		source: DISCORD_EVENT_SOURCE,
		subject: session.key,
		occurredAt: input.occurredAt.toISOString(),
		data: { scope: session.context, brief: input.brief },
	};
}
