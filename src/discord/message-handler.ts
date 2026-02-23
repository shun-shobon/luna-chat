import type { AiService } from "../ai/ai-service";
import type { RuntimeMessage } from "../context/types";
import { evaluateReplyPolicy } from "../policy/reply-policy";

export type MessageLike = {
  id: string;
  channelId: string;
  content: string;
  createdAt: Date;
  inGuild: () => boolean;
  reply: (text: string) => Promise<unknown>;
  mentions: {
    has: (userId: string) => boolean;
  };
  channel: {
    isThread: () => boolean;
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
  contextFetchLimit: number;
  aiService: AiService;
  apologyMessage: string;
  logger: LoggerLike;
};

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
    const aiResult = await input.aiService.generateReply({
      contextFetchLimit: input.contextFetchLimit,
      currentMessage,
      forceReply: policyDecision.forceReply,
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
