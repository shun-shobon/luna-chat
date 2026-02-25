export type ReplyPolicyInput = {
  allowedChannelIds: ReadonlySet<string>;
  channelId: string;
  isThread: boolean;
  isDm: boolean;
};

export type ReplyPolicyDecision = {
  shouldHandle: boolean;
};

export function evaluateReplyPolicy(input: ReplyPolicyInput): ReplyPolicyDecision {
  if (input.isDm || input.isThread) {
    return { shouldHandle: false };
  }

  if (!input.allowedChannelIds.has(input.channelId)) {
    return { shouldHandle: false };
  }

  return { shouldHandle: true };
}
