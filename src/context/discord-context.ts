import type { Collection, Message } from "discord.js";

import { formatDateTimeJst } from "./date-time";
import { toRuntimeReactions } from "./runtime-reaction";
import type { ConversationContext, RuntimeMessage } from "./types";

type ConversationContextChannel = {
  id: string;
  messages: {
    fetch: (options: { before?: string; limit: number }) => Promise<Collection<string, Message>>;
  };
};

type FetchConversationContextInput = {
  channel: ConversationContextChannel;
  botUserId: string;
  limit: number;
  requestedByToolUse: boolean;
  beforeMessageId?: string;
};

export async function fetchConversationContext(
  input: FetchConversationContextInput,
): Promise<ConversationContext> {
  const fetchOptions: { before?: string; limit: number } = {
    limit: input.limit,
  };
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

function toRuntimeMessage(message: Message, botUserId: string): RuntimeMessage {
  const reactions = toRuntimeReactions(
    Array.from(message.reactions?.cache.values() ?? []).map((reaction) => {
      return {
        count: reaction.count,
        emojiId: reaction.emoji.id,
        emojiName: reaction.emoji.name,
        selfReacted: reaction.me,
      };
    }),
  );

  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.username,
    authorIsBot: message.author.bot,
    content: message.content,
    mentionedBot: message.mentions.has(botUserId),
    createdAt: formatDateTimeJst(message.createdAt),
    ...(reactions ? { reactions } : {}),
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
