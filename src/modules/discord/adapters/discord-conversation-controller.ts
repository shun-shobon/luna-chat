import type { AcceptedConversationEvent } from "../../conversation/domain/conversation-session";
import {
	createDiscordConversationSession,
	createDiscordMessageDeletedEvent,
	createDiscordMessageEditedEvent,
	createDiscordMessageEvent,
	createDiscordReactionEvent,
} from "../domain/discord-event";
import { shouldAcceptMessage } from "../domain/message-acceptance";
import type {
	DiscordGatewayEventName,
	DiscordGatewayMessage,
	DiscordGatewayMessageDelete,
	DiscordGatewayMessageEdit,
	DiscordGatewayPort,
	DiscordGatewayReaction,
	DiscordGatewayTyping,
} from "../ports/discord-gateway-port";

type ConversationInput = Readonly<{
	accept(input: AcceptedConversationEvent): void;
	acceptFollowUp(input: AcceptedConversationEvent, targetId: string): void;
	remember(sessionKey: string, id: string): void;
	typing(session: AcceptedConversationEvent["session"], participantId: string): void;
	hasSession(sessionKey: string): boolean;
}>;

export class DiscordConversationController implements DiscordGatewayPort {
	constructor(
		private readonly conversation: ConversationInput,
		private readonly lunaUserId: string,
		private readonly options: Readonly<{
			allowDm: boolean;
			allowedChannelIds: ReadonlySet<string>;
			createId(): string;
			now(): Date;
			// VCに紐づいた会話のスコープは、一時セッションと同じく常設でなくても受け付ける。
			isVoiceBound(sessionKey: string): boolean;
			onAccepted(event: DiscordGatewayMessage): void;
			onError(error: unknown, event: DiscordGatewayEventName): void;
		}>,
	) {}

	onMessage(event: DiscordGatewayMessage): void {
		const session = createDiscordConversationSession(event.scope);
		if (event.message.author.id === this.lunaUserId) {
			this.conversation.remember(session.key, event.message.id);
			return;
		}
		const accepted = shouldAcceptMessage({
			scope: event.scope,
			authorId: event.message.author.id,
			lunaUserId: this.lunaUserId,
			mentionsLuna: event.message.mentions.users.some((user) => user.id === this.lunaUserId),
			allowDm: this.options.allowDm,
			allowedChannelIds: this.options.allowedChannelIds,
			lunaIsThreadMember: event.lunaIsThreadMember,
			sessionExists:
				this.conversation.hasSession(session.key) || this.options.isVoiceBound(session.key),
		});
		if (accepted) {
			this.conversation.accept({
				session,
				event: createDiscordMessageEvent(session, event.message),
			});
			this.options.onAccepted(event);
		}
	}

	onMessageEdit(event: DiscordGatewayMessageEdit): void {
		if (event.message.author.id === this.lunaUserId) return;
		const session = createDiscordConversationSession(event.scope);
		this.conversation.acceptFollowUp(
			{
				session,
				event: createDiscordMessageEditedEvent(session, {
					id: this.options.createId(),
					editedAt: event.editedAt,
					message: event.message,
				}),
			},
			event.message.id,
		);
	}

	onMessageDelete(event: DiscordGatewayMessageDelete): void {
		if (event.authorId === this.lunaUserId) return;
		const session = createDiscordConversationSession(event.scope);
		this.conversation.acceptFollowUp(
			{
				session,
				event: createDiscordMessageDeletedEvent(session, {
					id: this.options.createId(),
					messageId: event.messageId,
					occurredAt: this.options.now(),
				}),
			},
			event.messageId,
		);
	}

	onReaction(event: DiscordGatewayReaction): void {
		if (event.user.id === this.lunaUserId) return;
		const session = createDiscordConversationSession(event.scope);
		this.conversation.acceptFollowUp(
			{
				session,
				event: createDiscordReactionEvent(session, {
					id: this.options.createId(),
					action: event.action,
					emoji: event.emoji,
					messageId: event.messageId,
					occurredAt: this.options.now(),
					user: event.user,
				}),
			},
			event.messageId,
		);
	}

	onTyping(event: DiscordGatewayTyping): void {
		if (event.isHuman) {
			this.conversation.typing(createDiscordConversationSession(event.scope), event.userId);
		}
	}

	onError(error: unknown, event: DiscordGatewayEventName): void {
		this.options.onError(error, event);
	}
}
