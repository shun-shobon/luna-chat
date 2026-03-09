import type { TypingLifecycleRegistry } from "../../../typing/typing-lifecycle-registry";
import type {
  DiscordCommandGateway,
  DiscordCommandTarget,
} from "../../ports/outbound/discord-command-gateway-port";

export async function sendMessageTool(input: {
  filePaths?: string[];
  gateway: DiscordCommandGateway;
  replyToMessageId?: string;
  target: DiscordCommandTarget;
  text?: string;
  typingRegistry: TypingLifecycleRegistry;
}): Promise<{ ok: true }> {
  const channelId = await input.gateway.resolveChannelId(input.target);
  const payload = await input.gateway.sendMessage({
    channelId,
    filePaths: input.filePaths,
    replyToMessageId: input.replyToMessageId,
    text: input.text,
  });
  input.typingRegistry.stopByChannelId(channelId);
  return payload;
}
