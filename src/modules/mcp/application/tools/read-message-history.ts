import { formatMessageAuthorLabel } from "../../../../shared/discord/message-author-label";
import type { RuntimeReaction } from "../../../../shared/discord/runtime-reaction";
import type { DiscordAttachmentInput } from "../../../attachments";
import type { DiscordHistoryGateway } from "../../ports/outbound/discord-history-gateway-port";

export type AttachmentContentDecorator = (input: {
  attachments: DiscordAttachmentInput[];
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
