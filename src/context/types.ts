export type RuntimeMessage = {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  mentionedBot: boolean;
  createdAt: string;
};

export type ConversationContext = {
  channelId: string;
  recentMessages: RuntimeMessage[];
  requestedByToolUse: boolean;
};
