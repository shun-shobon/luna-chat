export type AiDecisionInput = {
  forceReply: boolean;
  messageContent: string;
};

export type AiDecisionOutput = {
  shouldReply: boolean;
  replyText: string;
};

export interface AiService {
  decideReply(input: AiDecisionInput): Promise<AiDecisionOutput>;
}

const REPLY_TRIGGER_PATTERN = /[?？]|ルナ|るな|luna|こんにちは|こんばんは|おはよう/u;

export class StubAiService implements AiService {
  async decideReply(input: AiDecisionInput): Promise<AiDecisionOutput> {
    if (input.forceReply) {
      return {
        shouldReply: true,
        replyText: "呼んだ？ ここにいるよ。",
      };
    }

    const shouldReply = REPLY_TRIGGER_PATTERN.test(input.messageContent);
    if (!shouldReply) {
      return {
        shouldReply: false,
        replyText: "",
      };
    }

    return {
      shouldReply: true,
      replyText: "うん、どうしたの？",
    };
  }
}
