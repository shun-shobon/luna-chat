import type { ConversationScope } from "../../discord/domain/conversation-scope";
import type { DiscordMessage } from "../../discord/domain/discord-message";

export interface ConversationHistoryPort {
  fetchBefore(
    scope: ConversationScope,
    beforeMessageId: string,
    limit: number,
  ): Promise<readonly DiscordMessage[]>;
}
