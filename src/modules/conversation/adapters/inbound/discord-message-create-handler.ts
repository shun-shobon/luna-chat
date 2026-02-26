import { Collection } from "discord.js";

import type { DiscordAttachmentStore } from "../../../../attachments/discord-attachment-store";
import { createTypingLifecycleRegistry } from "../../../typing/typing-lifecycle-registry";
import type {
  RuntimeMessage,
  RuntimeReaction,
  RuntimeReplyMessage,
} from "../../domain/runtime-message";
import { toRuntimeReactions } from "../../domain/runtime-reaction";

export type { RuntimeMessage, RuntimeReaction, RuntimeReplyMessage };

type AttachmentSource = {
  id: string;
  name?: string | null;
  url: string;
};

type DiscordAttachmentInput = {
  id: string;
  name: string | null;
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

export type GenerateReplyInput = {
  channelName: string;
  currentMessage: RuntimeMessage;
  recentMessages: RuntimeMessage[];
};

export type ReplyGenerator = {
  generateReply: (input: GenerateReplyInput) => Promise<void>;
};

export type HandleMessageInput = {
  attachmentStore: DiscordAttachmentStore;
  message: MessageLike;
  botUserId: string;
  allowedChannelIds: ReadonlySet<string>;
  aiService: ReplyGenerator;
  logger: LoggerLike;
  typingLifecycleRegistry?: ReturnType<typeof createTypingLifecycleRegistry>;
};

type ReplyPolicyInput = {
  allowedChannelIds: ReadonlySet<string>;
  channelId: string;
  isThread: boolean;
  isDm: boolean;
};

const INITIAL_PROMPT_HISTORY_LIMIT = 10;
const defaultTypingLifecycleRegistry = createTypingLifecycleRegistry();

export async function handleMessageCreate(input: HandleMessageInput): Promise<void> {
  const { message } = input;
  const typingLifecycleRegistry = input.typingLifecycleRegistry ?? defaultTypingLifecycleRegistry;
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
    ? typingLifecycleRegistry.start({
        channelId: message.channelId,
        onTypingError: (error) => {
          input.logger.warn("Failed to send typing indicator:", error);
        },
        sendTyping: toSendTyping(message.channel),
        source: `message:${message.id}`,
      }).stop
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

function toSendTyping(
  channel: Pick<MessageLike["channel"], "sendTyping">,
): (() => Promise<unknown>) | undefined {
  if (!channel.sendTyping) {
    return undefined;
  }

  return channel.sendTyping.bind(channel);
}

function evaluateReplyPolicy(input: ReplyPolicyInput): { shouldHandle: boolean } {
  if (input.isDm || input.isThread) {
    return { shouldHandle: false };
  }

  if (!input.allowedChannelIds.has(input.channelId)) {
    return { shouldHandle: false };
  }

  return { shouldHandle: true };
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
  const fetchBound = fetchCandidate.bind(messages);
  return (options) => {
    return fetchBound(options);
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

function formatDateTimeJst(date: Date): string {
  const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1_000);
  const year = String(jstDate.getUTCFullYear());
  const month = String(jstDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jstDate.getUTCDate()).padStart(2, "0");
  const hours = String(jstDate.getUTCHours()).padStart(2, "0");
  const minutes = String(jstDate.getUTCMinutes()).padStart(2, "0");
  const seconds = String(jstDate.getUTCSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} JST`;
}

async function appendAttachmentMarkersFromSources(input: {
  attachmentStore: DiscordAttachmentStore;
  attachments: readonly DiscordAttachmentInput[];
  channelId: string;
  content: string;
  logger: Pick<LoggerLike, "warn">;
  messageId: string;
}): Promise<string> {
  const attachmentPaths: string[] = [];
  for (const attachment of input.attachments) {
    try {
      const savedPath = await input.attachmentStore.saveAttachment(attachment);
      attachmentPaths.push(savedPath);
    } catch (error: unknown) {
      input.logger.warn("Failed to save Discord attachment:", {
        attachmentId: attachment.id,
        channelId: input.channelId,
        error,
        messageId: input.messageId,
        url: attachment.url,
      });
    }
  }

  return appendAttachmentMarkers(input.content, attachmentPaths);
}

function appendAttachmentMarkers(content: string, attachmentPaths: readonly string[]): string {
  if (attachmentPaths.length === 0) {
    return content;
  }

  const markerLine = attachmentPaths.map((path) => `<attachment:${path}>`).join(" ");
  if (content.length === 0) {
    return markerLine;
  }

  return `${content}\n${markerLine}`;
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
