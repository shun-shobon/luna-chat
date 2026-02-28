export type DiscordAttachmentInput = {
  id: string;
  name: string | null;
  url: string;
};

export interface DiscordAttachmentStore {
  saveAttachment(input: DiscordAttachmentInput): Promise<string>;
}
