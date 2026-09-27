import { SnowflakeUtil } from "discord.js";

import type { ConversationHistoryPort } from "../../conversation/ports/conversation-history-port";
import type { LunaEvent } from "../../event/domain/luna-event";
import { conversationScopeKey, conversationScopeSchema } from "../domain/conversation-scope";
import {
  createDiscordMessageEvent,
  DISCORD_CONVERSATION_DELEGATED_EVENT_TYPE,
  DISCORD_EVENT_SOURCE,
  DISCORD_MESSAGE_CREATED_EVENT_TYPE,
  discordDelegatedEventDataSchema,
  discordMessageEventDataSchema,
} from "../domain/discord-event";
import type { DiscordReadPort } from "../ports/discord-read-port";

export class DiscordConversationHistory implements ConversationHistoryPort {
  constructor(private readonly discord: DiscordReadPort) {}

  async fetchBefore(
    session: Parameters<ConversationHistoryPort["fetchBefore"]>[0],
    beforeEvent: Parameters<ConversationHistoryPort["fetchBefore"]>[1],
    limit: number,
  ): Promise<readonly LunaEvent[]> {
    const scope = conversationScopeSchema.parse(session.context);
    assertSession(session.source, session.key, scope);
    const before = parseDiscordBeforeEvent(beforeEvent, session.key);
    if (conversationScopeKey(before.scope) !== conversationScopeKey(scope)) {
      throw new Error("Discord before Event scope does not match its ConversationSession.");
    }
    if (limit === 0) return [];
    const channelId = scope.kind === "guild_thread" ? scope.threadId : scope.channelId;
    const events: LunaEvent[] = [];
    let cursor = before.cursor;
    let remaining = limit;
    while (remaining > 0) {
      const pageLimit = Math.min(remaining, 100);
      const page = await this.discord.readMessageHistory({
        beforeMessageId: cursor,
        channelId,
        limit: pageLimit,
      });
      events.unshift(...page.map((message) => createDiscordMessageEvent(scope, message)));
      if (page.length < pageLimit) break;
      const oldestMessage = page[0];
      if (oldestMessage === undefined) break;
      cursor = oldestMessage.id;
      remaining -= page.length;
    }
    return events;
  }
}

function assertSession(
  source: string,
  key: string,
  scope: ReturnType<typeof conversationScopeSchema.parse>,
): void {
  if (source !== DISCORD_EVENT_SOURCE) {
    throw new Error(`Discord history cannot read session source ${source}.`);
  }
  const expectedKey = `discord:${conversationScopeKey(scope)}`;
  if (key !== expectedKey) {
    throw new Error(`Discord session key ${key} does not match context ${expectedKey}.`);
  }
}

function parseDiscordBeforeEvent(event: LunaEvent, sessionKey: string) {
  if (event.source !== DISCORD_EVENT_SOURCE || event.subject !== sessionKey) {
    throw new Error("Discord history requires a Discord event from the same session.");
  }
  if (event.type === DISCORD_CONVERSATION_DELEGATED_EVENT_TYPE) {
    const data = discordDelegatedEventDataSchema.parse(event.data);
    return {
      scope: data.scope,
      cursor: SnowflakeUtil.generate({ timestamp: Date.parse(event.occurredAt) }).toString(),
    };
  }
  if (event.type !== DISCORD_MESSAGE_CREATED_EVENT_TYPE) {
    throw new Error(`Discord history cannot start before event type ${event.type}.`);
  }
  const data = discordMessageEventDataSchema.parse(event.data);
  if (data.message.id !== event.id) {
    throw new Error("Discord message event ID does not match its message ID.");
  }
  return { scope: data.scope, cursor: data.message.id };
}
