export type ReplyPolicyInput = {
  allowedChannelIds: ReadonlySet<string>;
  channelId: string;
  mentionedBot: boolean;
  isThread: boolean;
  isDm: boolean;
};

export type ReplyPolicyDecision = {
  shouldHandle: boolean;
  forceReply: boolean;
};

export function evaluateReplyPolicy(input: ReplyPolicyInput): ReplyPolicyDecision {
  if (input.isDm || input.isThread) {
    return { shouldHandle: false, forceReply: false };
  }

  if (!input.allowedChannelIds.has(input.channelId)) {
    return { shouldHandle: false, forceReply: false };
  }

  if (input.mentionedBot) {
    return { shouldHandle: true, forceReply: true };
  }

  return { shouldHandle: true, forceReply: false };
}
