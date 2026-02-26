import { Collection } from "discord.js";

import type { AiService } from "../ai/ai-service";
import {
  appendAttachmentMarkersFromSources,
  type DiscordAttachmentInput,
  type DiscordAttachmentStore,
} from "../attachments/discord-attachment-store";
import { formatDateTimeJst } from "../context/date-time";
import { toRuntimeReactions } from "../context/runtime-reaction";
import type { RuntimeMessage, RuntimeReplyMessage } from "../context/types";
import { evaluateReplyPolicy } from "../policy/reply-policy";

type AttachmentSource = {
  id: string;
  name?: string | null;
  url: string;
};

type ReactionSource = {
  count: number;
  emoji: {
    id?: string | null;
    name?: string | null;
  };
  me: boolean;
};

type ReactionsManagerSource = {
  cache: Collection<string, ReactionSource>;
};

type RuntimeMessageSource = {
  attachments?: Collection<string, AttachmentSource>;
  id: string;
  channelId: string;
  content: string;
  createdAt: Date;
  createdTimestamp: number;
  mentions: {
    has: (userId: string) => boolean;
  };
  author: {
    bot: boolean;
    id: string;
    username: string;
  };
  member?: {
    displayName: string;
  } | null;
  reactions?: ReactionsManagerSource;
  reference?: {
    messageId?: string | null | undefined;
  } | null;
  fetchReference?: () => Promise<RuntimeMessageSource>;
};

type SendTyping = () => Promise<unknown>;

export type MessageLike = {
  attachments?: Collection<string, AttachmentSource>;
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
    sendTyping?: SendTyping;
    messages?: unknown;
  };
  author: {
    bot: boolean;
    id: string;
    username: string;
  };
  member?: {
    displayName: string;
  } | null;
  reactions?: ReactionsManagerSource;
  reference?: {
    messageId?: string | null | undefined;
  } | null;
  fetchReference?: () => Promise<RuntimeMessageSource>;
};

export type LoggerLike = {
  debug?: (...arguments_: unknown[]) => void;
  info: (...arguments_: unknown[]) => void;
  warn: (...arguments_: unknown[]) => void;
  error: (...arguments_: unknown[]) => void;
};

export type HandleMessageInput = {
  attachmentStore: DiscordAttachmentStore;
  message: MessageLike;
  botUserId: string;
  allowedChannelIds: ReadonlySet<string>;
  aiService: AiService;
  logger: LoggerLike;
};

const INITIAL_PROMPT_HISTORY_LIMIT = 10;
const TYPING_INTERVAL_MS = 8_000;

export async function handleMessageCreate(input: HandleMessageInput): Promise<void> {
  const { message } = input;
  if (message.author.id === input.botUserId) {
    return;
  }

  const policyDecision = evaluateReplyPolicy({
    allowedChannelIds: input.allowedChannelIds,
    channelId: message.channelId,
    isDm: !message.inGuild(),
    isThread: message.channel.isThread(),
  });
  if (!policyDecision.shouldHandle) {
    return;
  }

  const currentMessage = await toRuntimeMessage({
    attachmentStore: input.attachmentStore,
    botUserId: input.botUserId,
    logger: input.logger,
    message,
  });
  input.logger.debug?.("discord.message.received_for_ai_turn", {
    channelId: currentMessage.channelId,
    mentionedBot: currentMessage.mentionedBot,
    messageId: currentMessage.id,
  });

  const stopTypingLoop = currentMessage.mentionedBot
    ? startTypingLoop({
        channel: message.channel,
        logger: input.logger,
      })
    : () => undefined;
  try {
    const recentMessages = await fetchRecentMessages({
      attachmentStore: input.attachmentStore,
      botUserId: input.botUserId,
      logger: input.logger,
      message,
    });
    await input.aiService.generateReply({
      channelName: resolveChannelName(message.channel.name),
      currentMessage,
      recentMessages,
    });
  } catch (error: unknown) {
    input.logger.error("Failed to generate AI reply:", error);
  } finally {
    stopTypingLoop();
  }
}

async function toRuntimeMessage(input: {
  message: MessageLike;
  botUserId: string;
  attachmentStore: DiscordAttachmentStore;
  logger: LoggerLike;
}): Promise<RuntimeMessage> {
  return toRuntimeMessageFromSource({
    attachmentStore: input.attachmentStore,
    botUserId: input.botUserId,
    logger: input.logger,
    message: input.message,
  });
}

async function toRuntimeMessageFromSource(input: {
  message: RuntimeMessageSource;
  botUserId: string;
  attachmentStore: DiscordAttachmentStore;
  logger: LoggerLike;
}): Promise<RuntimeMessage> {
  const content = await appendAttachmentMarkersFromSources({
    attachmentStore: input.attachmentStore,
    attachments: collectAttachments(input.message.attachments),
    channelId: input.message.channelId,
    content: input.message.content,
    logger: input.logger,
    messageId: input.message.id,
  });
  const replyTo = await resolveReplyToMessage({
    attachmentStore: input.attachmentStore,
    logger: input.logger,
    message: input.message,
  });
  const reactions = toRuntimeReactionsFromSource(input.message.reactions);

  return {
    id: input.message.id,
    channelId: input.message.channelId,
    authorId: input.message.author.id,
    authorName: input.message.member?.displayName ?? input.message.author.username,
    authorIsBot: input.message.author.bot,
    content,
    mentionedBot: input.message.mentions.has(input.botUserId),
    createdAt: formatDateTimeJst(input.message.createdAt),
    ...(reactions ? { reactions } : {}),
    ...(replyTo ? { replyTo } : {}),
  };
}

async function fetchRecentMessages(input: {
  message: MessageLike;
  botUserId: string;
  attachmentStore: DiscordAttachmentStore;
  logger: LoggerLike;
}): Promise<RuntimeMessage[]> {
  const fetchMessages = toMessageFetcher(input.message.channel.messages);
  if (!fetchMessages) {
    return [];
  }

  try {
    const fetched = await fetchMessages({
      before: input.message.id,
      limit: INITIAL_PROMPT_HISTORY_LIMIT,
    });
    if (!(fetched instanceof Collection)) {
      throw new Error("Unexpected fetch result type while reading channel history.");
    }
    const fetchedMessages = fetched;

    const sortedMessages = Array.from(fetchedMessages.values()).sort((left, right) => {
      return left.createdTimestamp - right.createdTimestamp;
    });
    return Promise.all(
      sortedMessages.map(async (message) => {
        return toRuntimeMessageFromSource({
          attachmentStore: input.attachmentStore,
          botUserId: input.botUserId,
          logger: input.logger,
          message,
        });
      }),
    );
  } catch (error: unknown) {
    input.logger.warn("Failed to fetch recent channel messages:", error);
    return [];
  }
}

function toMessageFetcher(
  messages: MessageLike["channel"]["messages"],
): ((options: { before?: string; limit: number }) => Promise<unknown>) | undefined {
  if (!messages || typeof messages !== "object") {
    return undefined;
  }
  if (!("fetch" in messages)) {
    return undefined;
  }
  const fetchCandidate = messages.fetch;
  if (typeof fetchCandidate !== "function") {
    return undefined;
  }
  return (options) => {
    return fetchCandidate(options);
  };
}

function collectAttachments(
  attachments: Collection<string, AttachmentSource> | undefined,
): DiscordAttachmentInput[] {
  if (!attachments) {
    return [];
  }

  return Array.from(attachments.values()).map((attachment) => {
    return {
      id: attachment.id,
      name: attachment.name ?? null,
      url: attachment.url,
    };
  });
}

async function resolveReplyToMessage(input: {
  message: RuntimeMessageSource;
  attachmentStore: DiscordAttachmentStore;
  logger: LoggerLike;
}): Promise<RuntimeReplyMessage | undefined> {
  const referencedMessageId = input.message.reference?.messageId;
  if (!referencedMessageId || !input.message.fetchReference) {
    return undefined;
  }

  try {
    const referencedMessage = await input.message.fetchReference();
    return await toRuntimeReplyMessageFromSource({
      attachmentStore: input.attachmentStore,
      logger: input.logger,
      message: referencedMessage,
    });
  } catch (error: unknown) {
    input.logger.warn("Failed to fetch referenced message:", {
      error,
      messageId: input.message.id,
      referencedMessageId,
    });
    return undefined;
  }
}

async function toRuntimeReplyMessageFromSource(input: {
  message: RuntimeMessageSource;
  attachmentStore: DiscordAttachmentStore;
  logger: LoggerLike;
}): Promise<RuntimeReplyMessage> {
  const content = await appendAttachmentMarkersFromSources({
    attachmentStore: input.attachmentStore,
    attachments: collectAttachments(input.message.attachments),
    channelId: input.message.channelId,
    content: input.message.content,
    logger: input.logger,
    messageId: input.message.id,
  });
  const reactions = toRuntimeReactionsFromSource(input.message.reactions);

  return {
    id: input.message.id,
    authorId: input.message.author.id,
    authorIsBot: input.message.author.bot,
    authorName: input.message.member?.displayName ?? input.message.author.username,
    content,
    createdAt: formatDateTimeJst(input.message.createdAt),
    ...(reactions ? { reactions } : {}),
  };
}

function toRuntimeReactionsFromSource(
  reactions: ReactionsManagerSource | undefined,
): RuntimeMessage["reactions"] {
  if (!reactions) {
    return undefined;
  }

  return toRuntimeReactions(
    Array.from(reactions.cache.values()).map((reaction) => {
      const emojiId = reaction.emoji.id;
      const emojiName = reaction.emoji.name;

      return {
        count: reaction.count,
        selfReacted: reaction.me,
        ...(emojiId !== undefined ? { emojiId } : {}),
        ...(emojiName !== undefined ? { emojiName } : {}),
      };
    }),
  );
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

function startTypingLoop(input: {
  channel: MessageLike["channel"];
  logger: LoggerLike;
}): () => void {
  if (!input.channel.sendTyping) {
    return () => undefined;
  }
  const sendTyping = input.channel.sendTyping.bind(input.channel);

  const runSendTyping = (): void => {
    void sendTyping().catch((error: unknown) => {
      input.logger.warn("Failed to send typing indicator:", error);
    });
  };

  runSendTyping();
  const interval = setInterval(runSendTyping, TYPING_INTERVAL_MS);

  return () => {
    clearInterval(interval);
  };
}
