import { REST, Routes } from "discord.js";
import { z } from "zod";

import type { RuntimeReaction } from "../../../../conversation/domain/runtime-message";
import { toRuntimeReactions } from "../../../../conversation/domain/runtime-reaction";

export type DiscordHistoryMessage = {
  attachments: Array<{
    id: string;
    name: string | null;
    url: string;
  }>;
  authorId: string;
  authorIsBot: boolean;
  authorName: string;
  content: string;
  createdAt: string;
  id: string;
  reactions?: RuntimeReaction[];
};

const discordApiAttachmentSchema = z.object({
  filename: z.string(),
  id: z.string(),
  url: z.string(),
});

const discordApiReactionEmojiSchema = z.object({
  id: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});

const discordApiReactionSchema = z.object({
  count: z.number().int().min(0),
  emoji: discordApiReactionEmojiSchema,
  me: z.boolean().optional().default(false),
});

const discordApiMessageSchema = z.object({
  attachments: z.array(discordApiAttachmentSchema).optional().default([]),
  author: z.object({
    bot: z.boolean().optional().default(false),
    id: z.string(),
    username: z.string(),
  }),
  content: z.string(),
  id: z.string(),
  reactions: z.array(discordApiReactionSchema).optional().default([]),
  timestamp: z.string(),
});

export type DiscordHistoryGateway = {
  fetchMessages: (input: {
    beforeMessageId?: string;
    channelId: string;
    limit: number;
  }) => Promise<DiscordHistoryMessage[]>;
};

export function createDiscordRestHistoryGateway(rest: Pick<REST, "get">): DiscordHistoryGateway {
  return {
    fetchMessages: async ({ beforeMessageId, channelId, limit }) => {
      const query = new URLSearchParams();
      query.set("limit", String(limit));
      if (beforeMessageId) {
        query.set("before", beforeMessageId);
      }

      const rawMessages = await rest.get(Routes.channelMessages(channelId), {
        query,
      });

      return parseDiscordMessages(rawMessages);
    },
  };
}

export function parseDiscordMessages(rawMessages: unknown): DiscordHistoryMessage[] {
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  const messages: DiscordHistoryMessage[] = [];
  for (const rawMessage of rawMessages) {
    const parsed = discordApiMessageSchema.safeParse(rawMessage);
    if (!parsed.success) {
      continue;
    }
    const message = parsed.data;

    const reactions = toRuntimeReactions(
      message.reactions.map((reaction) => {
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

    messages.push({
      attachments: message.attachments.map((attachment) => {
        return {
          id: attachment.id,
          name: attachment.filename,
          url: attachment.url,
        };
      }),
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      authorName: message.author.username,
      content: message.content,
      createdAt: message.timestamp,
      id: message.id,
      ...(reactions ? { reactions } : {}),
    });
  }

  return messages;
}
