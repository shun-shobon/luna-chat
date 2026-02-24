import type { Collection } from "discord.js";

import type { AiService } from "../ai/ai-service";
import { formatDateTimeJst } from "../context/date-time";
import type { RuntimeMessage } from "../context/types";
import { evaluateReplyPolicy } from "../policy/reply-policy";

type RuntimeMessageSource = {
  id: string;
  channelId: string;
  content: string;
  createdAt: Date;
  createdTimestamp: number;
  mentions: {
    has: (userId: string) => boolean;
  };
  author: {
    id: string;
    username: string;
  };
  member?: {
    displayName: string;
  } | null;
};

type FetchedMessageCollectionLike = Collection<string, RuntimeMessageSource>;

export type MessageLike = {
  id: string;
  channelId: string;
  content: string;
  createdAt: Date;
  createdTimestamp: number;
  inGuild: () => boolean;
  reply: (text: string) => Promise<unknown>;
  mentions: {
    has: (userId: string) => boolean;
  };
  channel: {
    isThread: () => boolean;
    name?: string | null;
    messages?: {
      fetch: (options: { before?: string; limit: number }) => Promise<FetchedMessageCollectionLike>;
    };
  };
  author: {
    bot: boolean;
    id: string;
    username: string;
  };
  member?: {
    displayName: string;
  } | null;
};

export type LoggerLike = {
  debug?: (...arguments_: unknown[]) => void;
  info: (...arguments_: unknown[]) => void;
  warn: (...arguments_: unknown[]) => void;
  error: (...arguments_: unknown[]) => void;
};

export type HandleMessageInput = {
  message: MessageLike;
  botUserId: string;
  allowedChannelIds: ReadonlySet<string>;
  aiService: AiService;
  apologyMessage: string;
  logger: LoggerLike;
};

const INITIAL_PROMPT_HISTORY_LIMIT = 10;

export async function handleMessageCreate(input: HandleMessageInput): Promise<void> {
  const { message } = input;
  if (message.author.bot) {
    return;
  }

  const policyDecision = evaluateReplyPolicy({
    allowedChannelIds: input.allowedChannelIds,
    channelId: message.channelId,
    isDm: !message.inGuild(),
    isThread: message.channel.isThread(),
    mentionedBot: message.mentions.has(input.botUserId),
  });
  if (!policyDecision.shouldHandle) {
    return;
  }

  const currentMessage = toRuntimeMessage(message, input.botUserId);
  input.logger.debug?.("discord.message.received_for_ai_turn", {
    channelId: currentMessage.channelId,
    forceReply: policyDecision.forceReply,
    mentionedBot: currentMessage.mentionedBot,
    messageId: currentMessage.id,
  });

  try {
    const recentMessages = await fetchRecentMessages({
      botUserId: input.botUserId,
      logger: input.logger,
      message,
    });
    const aiResult = await input.aiService.generateReply({
      channelName: resolveChannelName(message.channel.name),
      currentMessage,
      forceReply: policyDecision.forceReply,
      recentMessages,
    });

    if (policyDecision.forceReply && !aiResult.didReply) {
      input.logger.debug?.("discord.message.force_reply_fallback", {
        messageId: currentMessage.id,
      });
      await message.reply(input.apologyMessage);
    }
  } catch (error: unknown) {
    input.logger.error("Failed to generate AI reply:", error);
    if (!policyDecision.forceReply) {
      return;
    }
    await message.reply(input.apologyMessage).catch((replyError: unknown) => {
      input.logger.error("Failed to send fallback apology message:", replyError);
    });
  }
}

function toRuntimeMessage(message: MessageLike, botUserId: string): RuntimeMessage {
  return toRuntimeMessageFromSource(message, botUserId);
}

function toRuntimeMessageFromSource(
  message: RuntimeMessageSource,
  botUserId: string,
): RuntimeMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.username,
    content: message.content,
    mentionedBot: message.mentions.has(botUserId),
    createdAt: formatDateTimeJst(message.createdAt),
  };
}

async function fetchRecentMessages(input: {
  message: MessageLike;
  botUserId: string;
  logger: LoggerLike;
}): Promise<RuntimeMessage[]> {
  if (!input.message.channel.messages) {
    return [];
  }

  try {
    const fetchedMessages = await input.message.channel.messages.fetch({
      before: input.message.id,
      limit: INITIAL_PROMPT_HISTORY_LIMIT,
    });

    return Array.from(fetchedMessages.values())
      .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
      .map((message) => toRuntimeMessageFromSource(message, input.botUserId));
  } catch (error: unknown) {
    input.logger.warn("Failed to fetch recent channel messages:", error);
    return [];
  }
}

function resolveChannelName(channelName: string | null | undefined): string {
  if (typeof channelName !== "string") {
    return "unknown";
  }

  const trimmed = channelName.trim();
  if (trimmed.length === 0) {
    return "unknown";
  }

  return trimmed;
}
