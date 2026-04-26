import type { RuntimeReaction } from "../../../../shared/discord/runtime-reaction";
import type { DiscordHistoryGateway } from "../../ports/outbound/discord-history-gateway-port";

const HISTORY_CURSOR_INPUT_ERROR_MESSAGE =
  "beforeMessageId / afterMessageId / aroundMessageId は同時に指定できません。";

export async function readMessageHistory(input: {
  afterMessageId?: string;
  aroundMessageId?: string;
  beforeMessageId?: string;
  channelId: string;
  gateway: DiscordHistoryGateway;
  limit: number;
}): Promise<{
  channelId: string;
  messages: Array<{
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
      return {
        attachments: message.attachments,
        authorId: message.authorId,
        authorIsBot: message.authorIsBot,
        authorName: message.authorName,
        content: message.content,
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
