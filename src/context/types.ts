export type RuntimeReplyMessage = {
  id: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  createdAt: string;
};

export type RuntimeMessage = {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  mentionedBot: boolean;
  createdAt: string;
  replyTo?: RuntimeReplyMessage;
};

export type ConversationContext = {
  channelId: string;
  recentMessages: RuntimeMessage[];
  requestedByToolUse: boolean;
};
