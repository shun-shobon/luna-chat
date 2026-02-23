export type RuntimeMessage = {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  mentionedBot: boolean;
  createdAt: string;
};

export type ConversationContext = {
  channelId: string;
  recentMessages: RuntimeMessage[];
  requestedByToolUse: boolean;
};
