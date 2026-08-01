import type { DiscordMessage } from "../../discord/domain/discord-message";
import type { DiscordReadPort } from "../../discord/ports/discord-read-port";
import type { ConversationHistoryPort } from "../ports/conversation-history-port";

export class DiscordConversationHistory implements ConversationHistoryPort {
  constructor(private readonly discord: DiscordReadPort) {}

  async fetchBefore(
    _scope: Parameters<ConversationHistoryPort["fetchBefore"]>[0],
    beforeMessageId: string,
    limit: number,
  ) {
    if (limit === 0) return [];
    const channelId = scopeChannelId(_scope);
    const messages: DiscordMessage[] = [];
    let cursor = beforeMessageId;
    let remaining = limit;
    while (remaining > 0) {
      const pageLimit = Math.min(remaining, 100);
      const page = await this.discord.readMessageHistory({
        beforeMessageId: cursor,
        channelId,
        limit: pageLimit,
      });
      messages.unshift(...page);
      if (page.length < pageLimit) break;
      const oldestMessage = page[0];
      if (oldestMessage === undefined) break;
      cursor = oldestMessage.id;
      remaining -= page.length;
    }
    return messages;
  }
}

function scopeChannelId(scope: Parameters<ConversationHistoryPort["fetchBefore"]>[0]): string {
  return scope.kind === "guild_thread" ? scope.threadId : scope.channelId;
}
