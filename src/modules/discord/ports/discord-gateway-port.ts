import type { ConversationScope } from "../domain/conversation-scope";
import type { DiscordMessage } from "../domain/discord-message";

export type DiscordGatewayMessage = Readonly<{
  lunaIsThreadMember: boolean;
  message: DiscordMessage;
  scope: ConversationScope;
}>;

export type DiscordGatewayTyping = Readonly<{
  scope: ConversationScope;
  userId: string;
  isHuman: boolean;
}>;

export interface DiscordGatewayPort {
  onMessage(event: DiscordGatewayMessage): Promise<void> | void;
  onTyping(event: DiscordGatewayTyping): Promise<void> | void;
  onError(error: unknown, event: "messageCreate" | "typingStart"): void;
}
