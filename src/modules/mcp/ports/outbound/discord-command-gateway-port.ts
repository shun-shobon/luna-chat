export type DiscordCommandGateway = {
  addReaction: (input: {
    channelId: string;
    emoji: string;
    messageId: string;
  }) => Promise<{ ok: true }>;
  sendMessage: (input: {
    channelId: string;
    replyToMessageId?: string;
    text: string;
  }) => Promise<{ ok: true }>;
  sendTyping: (channelId: string) => Promise<void>;
};
