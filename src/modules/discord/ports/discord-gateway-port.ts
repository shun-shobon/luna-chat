import type { ConversationScope } from "../domain/conversation-scope";
import type { DiscordMessage, DiscordReactionEmoji } from "../domain/discord-message";

export type DiscordGatewayEventName =
	| "messageCreate"
	| "messageUpdate"
	| "messageDelete"
	| "messageReactionAdd"
	| "messageReactionRemove"
	| "typingStart";

export type DiscordGatewayMessage = Readonly<{
	lunaIsThreadMember: boolean;
	message: DiscordMessage;
	scope: ConversationScope;
}>;

export type DiscordGatewayMessageEdit = Readonly<{
	editedAt: string;
	message: DiscordMessage;
	scope: ConversationScope;
}>;

export type DiscordGatewayMessageDelete = Readonly<{
	// キャッシュにないメッセージの削除は、Discordが投稿者を通知しないため分からない。
	authorId: string | null;
	messageId: string;
	scope: ConversationScope;
}>;

export type DiscordGatewayReaction = Readonly<{
	action: "added" | "removed";
	emoji: DiscordReactionEmoji;
	messageId: string;
	scope: ConversationScope;
	user: Readonly<{ id: string; username: string; displayName: string | null }>;
}>;

export type DiscordGatewayTyping = Readonly<{
	scope: ConversationScope;
	userId: string;
	isHuman: boolean;
}>;

export interface DiscordGatewayPort {
	onMessage(event: DiscordGatewayMessage): void;
	onMessageEdit(event: DiscordGatewayMessageEdit): void;
	onMessageDelete(event: DiscordGatewayMessageDelete): void;
	onReaction(event: DiscordGatewayReaction): void;
	onTyping(event: DiscordGatewayTyping): void;
	onError(error: unknown, event: DiscordGatewayEventName): void;
}
