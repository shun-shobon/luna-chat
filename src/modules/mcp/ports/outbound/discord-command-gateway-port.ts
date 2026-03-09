export type DiscordCommandTarget = { channelId: string } | { userId: string };

export type DiscordCommandGateway = {
  resolveChannelId: (target: DiscordCommandTarget) => Promise<string>;
  addReaction: (input: {
    channelId: string;
    emoji: string;
    messageId: string;
  }) => Promise<{ ok: true }>;
  sendMessage: (input: {
    channelId: string;
    filePaths?: string[];
    replyToMessageId?: string;
    text?: string;
  }) => Promise<{ ok: true }>;
  sendTyping: (channelId: string) => Promise<void>;
};
