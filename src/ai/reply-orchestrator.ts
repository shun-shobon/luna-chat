import type { ConversationContext, RuntimeMessage } from "../context/types";

import type { AiOutput, AiService } from "./ai-service";

export type ResolveAiReplyInput = {
  aiService: AiService;
  currentMessage: RuntimeMessage;
  initialContext: ConversationContext;
  operationRulesDoc: string;
  forceReply: boolean;
  fetchMoreHistory: (beforeMessageId: string) => Promise<ConversationContext>;
  logger: { info: (...arguments_: unknown[]) => void };
};

export async function resolveAiReplyWithHistoryLoop(input: ResolveAiReplyInput): Promise<AiOutput> {
  let context = input.initialContext;
  let fetchRound = 0;
  let totalHistorySize = context.recentMessages.length;

  // Tool use による追加履歴要求は上限を設けずに継続する。
  while (true) {
    const output = await input.aiService.generateReply({
      context,
      currentMessage: input.currentMessage,
      forceReply: input.forceReply,
      operationRulesDoc: input.operationRulesDoc,
    });

    if (!output.needsMoreHistory) {
      return output;
    }

    const beforeMessageId = pickBeforeMessageId(output, context.recentMessages);
    if (!beforeMessageId) {
      return {
        ...output,
        needsMoreHistory: false,
      };
    }

    const additionalContext = await input.fetchMoreHistory(beforeMessageId);
    if (additionalContext.recentMessages.length === 0) {
      return {
        ...output,
        needsMoreHistory: false,
      };
    }

    context = {
      channelId: context.channelId,
      recentMessages: mergeMessages(additionalContext.recentMessages, context.recentMessages),
      requestedByToolUse: true,
    };

    fetchRound += 1;
    totalHistorySize += additionalContext.recentMessages.length;
    input.logger.info(
      `Fetched additional history via tool use: round=${fetchRound}, added=${additionalContext.recentMessages.length}, total=${totalHistorySize}`,
    );
  }
}

function pickBeforeMessageId(
  output: AiOutput,
  recentMessages: RuntimeMessage[],
): string | undefined {
  if (output.requestedBeforeMessageId) {
    return output.requestedBeforeMessageId;
  }

  return recentMessages[0]?.id;
}

function mergeMessages(
  olderMessages: RuntimeMessage[],
  recentMessages: RuntimeMessage[],
): RuntimeMessage[] {
  const merged = [...olderMessages, ...recentMessages];
  const uniqueMessagesById = new Map(merged.map((message) => [message.id, message] as const));

  return Array.from(uniqueMessagesById.values()).sort((left, right) => {
    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
}
