import type { Collection, Message, TextBasedChannel } from "discord.js";

import type { ConversationContext, RuntimeMessage } from "./types";

export type FetchConversationContextInput = {
  channel: TextBasedChannel;
  botUserId: string;
  limit: number;
  requestedByToolUse: boolean;
  beforeMessageId?: string;
};

export async function fetchConversationContext(
  input: FetchConversationContextInput,
): Promise<ConversationContext> {
  const fetchOptions = {
    limit: input.limit,
  } as { limit: number; before?: string };
  if (input.beforeMessageId) {
    fetchOptions.before = input.beforeMessageId;
  }

  const fetchedMessages = await input.channel.messages.fetch(fetchOptions);

  return {
    channelId: input.channel.id,
    recentMessages: toRuntimeMessages(fetchedMessages, input.botUserId),
    requestedByToolUse: input.requestedByToolUse,
  };
}

export function toRuntimeMessage(message: Message, botUserId: string): RuntimeMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.username,
    content: message.content,
    mentionedBot: message.mentions.has(botUserId),
    createdAt: message.createdAt.toISOString(),
  };
}

function toRuntimeMessages(
  fetchedMessages: Collection<string, Message>,
  botUserId: string,
): RuntimeMessage[] {
  return Array.from(fetchedMessages.values())
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .map((message) => toRuntimeMessage(message, botUserId));
}
