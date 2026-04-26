import type { RuntimeReaction } from "../../../shared/discord/runtime-reaction";

export type { RuntimeReaction };

export type RuntimeAttachment = {
  id: string;
  name: string | null;
  url: string;
};

export type RuntimeReplyMessage = {
  id: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  createdAt: string;
  attachments: RuntimeAttachment[];
  reactions?: RuntimeReaction[];
};

export type RuntimeMessage = {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  attachments: RuntimeAttachment[];
  mentionedBot: boolean;
  createdAt: string;
  reactions?: RuntimeReaction[];
  replyTo?: RuntimeReplyMessage;
};
