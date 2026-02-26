import type { DiscordCommandGateway } from "../../adapters/outbound/discord/discord-rest-command-gateway";

export async function sendMessageTool(input: {
  channelId: string;
  gateway: DiscordCommandGateway;
  replyToMessageId?: string;
  text: string;
}): Promise<{ ok: true }> {
  return await input.gateway.sendMessage({
    channelId: input.channelId,
    text: input.text,
    ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }),
  });
}
