import type { RuntimeReaction } from "../../../shared/discord/runtime-reaction";
import type { RuntimeSticker } from "../../../shared/discord/runtime-sticker";

export type { RuntimeReaction };
export type { RuntimeSticker };

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
  stickers?: RuntimeSticker[];
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
  stickers?: RuntimeSticker[];
  replyTo?: RuntimeReplyMessage;
};
