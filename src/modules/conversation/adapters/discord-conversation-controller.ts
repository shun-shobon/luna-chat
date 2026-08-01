import type {
  DiscordGatewayMessage,
  DiscordGatewayPort,
  DiscordGatewayTyping,
} from "../../discord/ports/discord-gateway-port";
import type { ConversationCoordinator } from "../application/conversation-coordinator";
import { shouldAcceptMessage } from "../domain/message-acceptance";

export class DiscordConversationController implements DiscordGatewayPort {
  readonly #allowedChannelIds: ReadonlySet<string>;

  constructor(
    private readonly conversation: Pick<
      ConversationCoordinator,
      "accept" | "typing" | "hasSession"
    >,
    private readonly lunaUserId: string,
    input: Readonly<{
      allowDm: boolean;
      allowedChannelIds: readonly string[];
      onAccepted(event: DiscordGatewayMessage): void;
      onError(error: unknown, event: "messageCreate" | "typingStart"): void;
    }>,
  ) {
    this.#allowedChannelIds = new Set(input.allowedChannelIds);
    this.allowDm = input.allowDm;
    this.onAccepted = input.onAccepted;
    this.onError = input.onError;
  }

  private readonly allowDm: boolean;
  private readonly onAccepted: (event: DiscordGatewayMessage) => void;
  readonly onError: (error: unknown, event: "messageCreate" | "typingStart") => void;

  onMessage(event: DiscordGatewayMessage): void {
    const accepted = shouldAcceptMessage({
      scope: event.scope,
      authorId: event.message.author.id,
      lunaUserId: this.lunaUserId,
      mentionsLuna: event.message.mentions.users.some((user) => user.id === this.lunaUserId),
      allowDm: this.allowDm,
      allowedChannelIds: this.#allowedChannelIds,
      sessionExists: this.conversation.hasSession(event.scope),
    });
    if (accepted) {
      this.conversation.accept(event);
      this.onAccepted(event);
    }
  }

  onTyping(event: DiscordGatewayTyping): void {
    if (event.isHuman) this.conversation.typing(event.scope, event.userId);
  }
}
