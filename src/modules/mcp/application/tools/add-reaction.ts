import type { DiscordCommandGateway } from "../../ports/outbound/discord-command-gateway-port";

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
