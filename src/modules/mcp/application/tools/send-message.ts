import type { DiscordCommandGateway } from "../../ports/outbound/discord-command-gateway-port";

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
