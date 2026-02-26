import type { DiscordCommandGateway } from "../../adapters/outbound/discord/discord-rest-command-gateway";

export async function addReactionTool(input: {
  channelId: string;
  emoji: string;
  gateway: DiscordCommandGateway;
  messageId: string;
}): Promise<{ ok: true }> {
  return await input.gateway.addReaction({
    channelId: input.channelId,
    emoji: input.emoji,
    messageId: input.messageId,
  });
}
