import type { ConversationSession } from "../../conversation/domain/conversation-session";
import type { LunaEvent } from "../../event/domain/luna-event";
import { conversationScopeKey, conversationScopeSchema } from "./conversation-scope";
import type { ConversationScope } from "./conversation-scope";
import type { DiscordMessage, DiscordReactionEmoji } from "./discord-message";

export const DISCORD_EVENT_SOURCE = "discord/main";
export const DISCORD_MESSAGE_CREATED_EVENT_TYPE = "discord.message.created.v1";
export const DISCORD_MESSAGE_EDITED_EVENT_TYPE = "discord.message.edited.v1";
export const DISCORD_MESSAGE_DELETED_EVENT_TYPE = "discord.message.deleted.v1";
export const DISCORD_REACTION_ADDED_EVENT_TYPE = "discord.reaction.added.v1";
export const DISCORD_REACTION_REMOVED_EVENT_TYPE = "discord.reaction.removed.v1";
export const DISCORD_CONVERSATION_DELEGATED_EVENT_TYPE = "discord.conversation.delegated.v1";

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

export function createDiscordMessageEditedEvent(
	session: ConversationSession,
	input: Readonly<{ id: string; editedAt: string; message: DiscordMessage }>,
): LunaEvent {
	return {
		id: input.id,
		type: DISCORD_MESSAGE_EDITED_EVENT_TYPE,
		source: DISCORD_EVENT_SOURCE,
		subject: session.key,
		occurredAt: input.editedAt,
		data: { scope: session.context, message: input.message },
	};
}

export function createDiscordMessageDeletedEvent(
	session: ConversationSession,
	input: Readonly<{ id: string; messageId: string; occurredAt: Date }>,
): LunaEvent {
	return {
		id: input.id,
		type: DISCORD_MESSAGE_DELETED_EVENT_TYPE,
		source: DISCORD_EVENT_SOURCE,
		subject: session.key,
		occurredAt: input.occurredAt.toISOString(),
		data: { scope: session.context, messageId: input.messageId },
	};
}

export function createDiscordReactionEvent(
	session: ConversationSession,
	input: Readonly<{
		id: string;
		action: "added" | "removed";
		emoji: DiscordReactionEmoji;
		messageId: string;
		occurredAt: Date;
		user: Readonly<{ id: string; username: string; displayName: string | null }>;
	}>,
): LunaEvent {
	return {
		id: input.id,
		type:
			input.action === "added"
				? DISCORD_REACTION_ADDED_EVENT_TYPE
				: DISCORD_REACTION_REMOVED_EVENT_TYPE,
		source: DISCORD_EVENT_SOURCE,
		subject: session.key,
		occurredAt: input.occurredAt.toISOString(),
		data: {
			scope: session.context,
			messageId: input.messageId,
			emoji: input.emoji,
			user: { ...input.user },
		},
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

export function isDiscordConversationSession(
	session: Pick<ConversationSession, "context" | "source">,
): boolean {
	return (
		session.source === DISCORD_EVENT_SOURCE &&
		conversationScopeSchema.safeParse(session.context).success
	);
}

export function isDiscordGuildSession(
	session: Pick<ConversationSession, "context" | "source">,
): boolean {
	if (session.source !== DISCORD_EVENT_SOURCE) return false;
	const scope = conversationScopeSchema.safeParse(session.context);
	return scope.success && scope.data.kind !== "dm";
}
