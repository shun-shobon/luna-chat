import type { ConversationScope } from "../domain/conversation-scope";
import type { DiscordTarget } from "../domain/discord-action";

export interface DiscordConversationDelegationPort {
  delegate(target: DiscordTarget, brief: string): Promise<ConversationScope>;
}
