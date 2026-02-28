import type { TypingLifecycleRegistry } from "../../../typing/typing-lifecycle-registry";
import type { DiscordCommandGateway } from "../../ports/outbound/discord-command-gateway-port";

export async function startTypingTool(input: {
  channelId: string;
  gateway: DiscordCommandGateway;
  typingRegistry: TypingLifecycleRegistry;
}): Promise<{ alreadyRunning: boolean; ok: true }> {
  return input.typingRegistry.start({
    channelId: input.channelId,
    sendTyping: async () => {
      await input.gateway.sendTyping(input.channelId);
    },
    source: "tool",
  });
}
