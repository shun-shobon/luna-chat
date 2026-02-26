import { formatMessageAuthorLabel } from "../../../ai/application/message-author-label";
import type { RuntimeReaction } from "../../../conversation/domain/runtime-message";
import type { DiscordHistoryGateway } from "../../adapters/outbound/discord/discord-rest-history-gateway";

export type AttachmentContentDecorator = (input: {
  attachments: Array<{
    id: string;
    name: string | null;
    url: string;
  }>;
  channelId: string;
  content: string;
  messageId: string;
}) => Promise<string>;

export async function readMessageHistory(input: {
  beforeMessageId?: string;
  channelId: string;
  decorator: AttachmentContentDecorator;
  gateway: DiscordHistoryGateway;
  limit: number;
}): Promise<{
  channelId: string;
  messages: Array<{
    authorId: string;
    authorIsBot: boolean;
    authorName: string;
    content: string;
    createdAt: string;
    id: string;
    reactions?: RuntimeReaction[];
  }>;
}> {
  const fetched = await input.gateway.fetchMessages({
    channelId: input.channelId,
    limit: input.limit,
    ...(input.beforeMessageId === undefined ? {} : { beforeMessageId: input.beforeMessageId }),
  });

  const messages = await Promise.all(
    fetched.reverse().map(async (message) => {
      const content = await input.decorator({
        attachments: message.attachments,
        channelId: input.channelId,
        content: message.content,
        messageId: message.id,
      });

      return {
        authorId: message.authorId,
        authorIsBot: message.authorIsBot,
        authorName: formatMessageAuthorLabel(message),
        content,
        createdAt: message.createdAt,
        id: message.id,
        ...(message.reactions ? { reactions: message.reactions } : {}),
      };
    }),
  );

  return {
    channelId: input.channelId,
    messages,
  };
}
