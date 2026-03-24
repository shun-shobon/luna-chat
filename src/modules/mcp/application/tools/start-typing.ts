import type { TypingLifecycleRegistry } from "../../../typing/typing-lifecycle-registry";
import type {
  DiscordCommandGateway,
  DiscordCommandTarget,
} from "../../ports/outbound/discord-command-gateway-port";

export async function startTypingTool(input: {
  gateway: DiscordCommandGateway;
  target: DiscordCommandTarget;
  typingRegistry: TypingLifecycleRegistry;
}): Promise<{ alreadyRunning: boolean; channelId: string; ok: true }> {
  const channelId = await input.gateway.resolveChannelId(input.target);
  const payload = input.typingRegistry.start({
    channelId,
    sendTyping: async () => {
      await input.gateway.sendTyping(channelId);
    },
    source: "tool",
  });

  return {
    ...payload,
    channelId,
  };
}
