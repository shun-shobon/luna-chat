import type { RuntimeReaction } from "../../../shared/discord/runtime-reaction";

export type { RuntimeReaction };

export type RuntimeReplyMessage = {
  id: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  createdAt: string;
  reactions?: RuntimeReaction[];
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
  reactions?: RuntimeReaction[];
  replyTo?: RuntimeReplyMessage;
};
