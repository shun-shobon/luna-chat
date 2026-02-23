import type { AiService } from "../ai/ai-service";
import type { ConversationContext, RuntimeMessage } from "../context/types";
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
  fetchConversationContext: (input: {
    beforeMessageId?: string;
    requestedByToolUse: boolean;
    limit: number;
  }) => Promise<ConversationContext>;
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

  try {
    const aiResult = await input.aiService.generateReply({
      contextFetchLimit: input.contextFetchLimit,
      currentMessage,
      forceReply: policyDecision.forceReply,
      tools: {
        fetchDiscordHistory: async ({ beforeMessageId, limit }) => {
          const fetchInput = {
            limit,
            requestedByToolUse: true,
          } as {
            beforeMessageId?: string;
            requestedByToolUse: boolean;
            limit: number;
          };
          if (beforeMessageId) {
            fetchInput.beforeMessageId = beforeMessageId;
          }

          return input.fetchConversationContext(fetchInput);
        },
        sendDiscordReply: async ({ text }) => {
          await message.reply(text);
        },
      },
    });

    if (policyDecision.forceReply && !aiResult.didReply) {
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
