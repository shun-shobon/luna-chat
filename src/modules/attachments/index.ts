export { appendAttachmentsToContent } from "./application/append-attachments-to-content";
export { appendAttachmentMarkers } from "./domain/attachment-marker";
export type {
  DiscordAttachmentInput,
  DiscordAttachmentStore,
} from "./ports/discord-attachment-store";
export { WorkspaceDiscordAttachmentStore } from "./adapters/outbound/workspace-discord-attachment-store";
