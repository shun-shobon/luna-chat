import { SnowflakeUtil } from "discord.js";

import type { ConversationHistoryPort } from "../../conversation/ports/conversation-history-port";
import type { LunaEvent } from "../../event/domain/luna-event";
import { conversationScopeSchema } from "../domain/conversation-scope";
import {
	createDiscordMessageEvent,
	DISCORD_CONVERSATION_DELEGATED_EVENT_TYPE,
	DISCORD_MESSAGE_CREATED_EVENT_TYPE,
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
		const channelId = scope.kind === "guild_thread" ? scope.threadId : scope.channelId;
		const events: LunaEvent[] = [];
		let cursor = beforeCursor(beforeEvent);
		let remaining = limit;
		while (remaining > 0) {
			const pageLimit = Math.min(remaining, 100);
			const page = await this.discord.readMessageHistory({
				beforeMessageId: cursor,
				channelId,
				limit: pageLimit,
			});
			events.unshift(...page.map((message) => createDiscordMessageEvent(session, message)));
			if (page.length < pageLimit) break;
			const oldestMessage = page[0];
			if (oldestMessage === undefined) break;
			cursor = oldestMessage.id;
			remaining -= page.length;
		}
		return events;
	}
}

function beforeCursor(event: LunaEvent): string {
	switch (event.type) {
		case DISCORD_MESSAGE_CREATED_EVENT_TYPE:
			return event.id;
		case DISCORD_CONVERSATION_DELEGATED_EVENT_TYPE:
			return SnowflakeUtil.generate({ timestamp: Date.parse(event.occurredAt) }).toString();
		default:
			throw new Error(`Discord history cannot start before event type ${event.type}.`);
	}
}
