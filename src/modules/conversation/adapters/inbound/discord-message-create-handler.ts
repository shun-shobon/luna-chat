import { Collection } from "discord.js";

import { formatDateTimeJst } from "../../../../shared/discord/format-date-time-jst";
import { toRuntimeReactions } from "../../../../shared/discord/runtime-reaction";
import { toRuntimeStickers } from "../../../../shared/discord/runtime-sticker";
import type { DiscordPromptContext } from "../../../ai/ports/inbound/ai-service-port";
import type { DiscordAiDispatcher } from "../../application/discord-ai-dispatcher";
import {
  resolveDiscordChannelScopeKey,
  resolveDiscordDmScopeKey,
} from "../../application/discord-ai-dispatcher";
import type {
  RuntimeAttachment,
  RuntimeMessage,
  RuntimeReplyMessage,
} from "../../domain/runtime-message";

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

type StickerSource = {
  id: string;
  name: string;
  description?: string | null;
  format?: number | string | null;
  url?: string | null;
  guildId?: string | null;
};

type RuntimeMessageSource = {
  attachments?: Collection<string, AttachmentSource>;
  stickers?: Collection<string, StickerSource>;
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
  stickers?: Collection<string, StickerSource>;
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

type TypingLike = {
  inGuild: () => boolean;
  channel: {
    id: string;
    isThread?: (() => boolean) | undefined;
  };
  user: {
    id: string;
  };
};

type LoggerLike = {
  info: (...arguments_: unknown[]) => void;
  warn: (...arguments_: unknown[]) => void;
  error: (...arguments_: unknown[]) => void;
};

type HandleMessageInput = {
  message: MessageLike;
  botUserId: string;
  allowedChannelIds: ReadonlySet<string>;
  allowDm: boolean;
  messageDispatcher: Pick<DiscordAiDispatcher, "enqueue">;
  logger: LoggerLike;
};

type HandleTypingStartInput = {
  typing: TypingLike;
  botUserId: string;
  allowedChannelIds: ReadonlySet<string>;
  allowDm: boolean;
  messageDispatcher: Pick<DiscordAiDispatcher, "recordTypingStart">;
};

type ReplyPolicyInput = {
  allowedChannelIds: ReadonlySet<string>;
  allowDm: boolean;
  channelId: string;
  isThread: boolean;
  isDm: boolean;
};

const INITIAL_PROMPT_HISTORY_LIMIT = 10;

export async function handleMessageCreate(input: HandleMessageInput): Promise<void> {
  const { message } = input;
  if (message.author.id === input.botUserId) {
    return;
  }

  const policyDecision = evaluateReplyPolicy({
    allowedChannelIds: input.allowedChannelIds,
    allowDm: input.allowDm,
    channelId: message.channelId,
    isDm: !message.inGuild(),
    isThread: message.channel.isThread(),
  });
  if (!policyDecision.shouldHandle) {
    return;
  }

  const currentMessage = await toRuntimeMessage({
    botUserId: input.botUserId,
    logger: input.logger,
    message,
  });

  input.messageDispatcher.enqueue({
    context: resolvePromptContext(message),
    currentMessage,
    loadRecentMessages: async () => {
      return await fetchRecentMessages({
        botUserId: input.botUserId,
        logger: input.logger,
        message,
      });
    },
    sendTyping: toSendTyping(message.channel),
  });
}

export function handleTypingStart(input: HandleTypingStartInput): void {
  const { typing } = input;
  if (typing.user.id === input.botUserId) {
    return;
  }

  const policyDecision = evaluateReplyPolicy({
    allowedChannelIds: input.allowedChannelIds,
    allowDm: input.allowDm,
    channelId: typing.channel.id,
    isDm: !typing.inGuild(),
    isThread: isTypingThread(typing),
  });
  if (!policyDecision.shouldHandle) {
    return;
  }

  input.messageDispatcher.recordTypingStart({
    scopeKey: typing.inGuild()
      ? resolveDiscordChannelScopeKey(typing.channel.id)
      : resolveDiscordDmScopeKey(typing.user.id),
    userId: typing.user.id,
  });
}

function isTypingThread(typing: TypingLike): boolean {
  return typing.channel.isThread?.() ?? false;
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
  if (input.isThread) {
    return { shouldHandle: false };
  }

  if (input.isDm) {
    return { shouldHandle: input.allowDm };
  }

  if (!input.allowedChannelIds.has(input.channelId)) {
    return { shouldHandle: false };
  }

  return { shouldHandle: true };
}

async function toRuntimeMessage(input: {
  message: MessageLike;
  botUserId: string;
  logger: LoggerLike;
}): Promise<RuntimeMessage> {
  return toRuntimeMessageFromSource({
    botUserId: input.botUserId,
    logger: input.logger,
    message: input.message,
  });
}

async function toRuntimeMessageFromSource(input: {
  message: RuntimeMessageSource;
  botUserId: string;
  logger: LoggerLike;
}): Promise<RuntimeMessage> {
  const replyTo = await resolveReplyToMessage({
    logger: input.logger,
    message: input.message,
  });
  const reactions = toRuntimeReactionsFromSource(input.message.reactions);
  const stickers = collectStickers(input.message.stickers);

  return {
    id: input.message.id,
    channelId: input.message.channelId,
    authorId: input.message.author.id,
    authorName: input.message.member?.displayName ?? input.message.author.username,
    authorIsBot: input.message.author.bot,
    content: input.message.content,
    attachments: collectAttachments(input.message.attachments),
    mentionedBot: input.message.mentions.has(input.botUserId),
    createdAt: formatDateTimeJst(input.message.createdAt),
    ...(reactions ? { reactions } : {}),
    ...(stickers ? { stickers } : {}),
    ...(replyTo ? { replyTo } : {}),
  };
}

async function fetchRecentMessages(input: {
  message: MessageLike;
  botUserId: string;
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
): RuntimeAttachment[] {
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
  logger: LoggerLike;
}): Promise<RuntimeReplyMessage | undefined> {
  const referencedMessageId = input.message.reference?.messageId;
  if (!referencedMessageId || !input.message.fetchReference) {
    return undefined;
  }

  try {
    const referencedMessage = await input.message.fetchReference();
    return await toRuntimeReplyMessageFromSource({
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
}): Promise<RuntimeReplyMessage> {
  const reactions = toRuntimeReactionsFromSource(input.message.reactions);
  const stickers = collectStickers(input.message.stickers);

  return {
    id: input.message.id,
    authorId: input.message.author.id,
    authorIsBot: input.message.author.bot,
    authorName: input.message.member?.displayName ?? input.message.author.username,
    content: input.message.content,
    attachments: collectAttachments(input.message.attachments),
    createdAt: formatDateTimeJst(input.message.createdAt),
    ...(reactions ? { reactions } : {}),
    ...(stickers ? { stickers } : {}),
  };
}

function collectStickers(
  stickers: Collection<string, StickerSource> | undefined,
): RuntimeMessage["stickers"] {
  if (!stickers) {
    return undefined;
  }

  return toRuntimeStickers(
    Array.from(stickers.values()).map((sticker) => {
      return {
        description: sticker.description ?? null,
        format: sticker.format ?? null,
        guildId: sticker.guildId ?? null,
        id: sticker.id,
        name: sticker.name,
        url: sticker.url ?? null,
      };
    }),
  );
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
        emojiId,
        emojiName,
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

function resolvePromptContext(
  message: Pick<MessageLike, "inGuild" | "channel">,
): DiscordPromptContext {
  if (!message.inGuild()) {
    return {
      kind: "dm",
    };
  }

  return {
    kind: "channel",
    channelName: resolveChannelName(message.channel.name),
  };
}
