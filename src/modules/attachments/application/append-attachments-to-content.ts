import { appendAttachmentMarkers } from "../domain/attachment-marker";
import type {
  DiscordAttachmentInput,
  DiscordAttachmentStore,
} from "../ports/discord-attachment-store";

type LoggerLike = {
  warn: (...arguments_: unknown[]) => void;
};

export async function appendAttachmentsToContent(input: {
  attachmentStore: DiscordAttachmentStore;
  attachments: readonly DiscordAttachmentInput[];
  channelId: string;
  content: string;
  logger: LoggerLike;
  messageId: string;
}): Promise<string> {
  const attachmentPaths: string[] = [];
  for (const attachment of input.attachments) {
    try {
      const savedPath = await input.attachmentStore.saveAttachment(attachment);
      attachmentPaths.push(savedPath);
    } catch (error: unknown) {
      input.logger.warn("Failed to save Discord attachment:", {
        attachmentId: attachment.id,
        channelId: input.channelId,
        error,
        messageId: input.messageId,
        url: attachment.url,
      });
    }
  }

  return appendAttachmentMarkers(input.content, attachmentPaths);
}
