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

const HISTORY_CURSOR_INPUT_ERROR_MESSAGE =
  "beforeMessageId / afterMessageId / aroundMessageId は同時に指定できません。";

export async function readMessageHistory(input: {
  afterMessageId?: string;
  aroundMessageId?: string;
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
  if (!hasExclusiveHistoryCursor(input)) {
    throw new Error(HISTORY_CURSOR_INPUT_ERROR_MESSAGE);
  }

  const fetched = await input.gateway.fetchMessages({
    afterMessageId: input.afterMessageId,
    aroundMessageId: input.aroundMessageId,
    channelId: input.channelId,
    limit: input.limit,
    beforeMessageId: input.beforeMessageId,
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
        reactions: message.reactions,
      };
    }),
  );

  return {
    channelId: input.channelId,
    messages,
  };
}

function hasExclusiveHistoryCursor(input: {
  afterMessageId?: string;
  aroundMessageId?: string;
  beforeMessageId?: string;
}): boolean {
  const cursors = [input.beforeMessageId, input.afterMessageId, input.aroundMessageId].filter(
    (value) => value !== undefined,
  );
  return cursors.length <= 1;
}
