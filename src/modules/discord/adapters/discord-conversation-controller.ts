import type { AcceptedConversationEvent } from "../../conversation/domain/conversation-session";
import {
  createDiscordConversationSession,
  createDiscordMessageEvent,
} from "../domain/discord-event";
import { shouldAcceptMessage } from "../domain/message-acceptance";
import type {
  DiscordGatewayMessage,
  DiscordGatewayPort,
  DiscordGatewayTyping,
} from "../ports/discord-gateway-port";

type ConversationInput = Readonly<{
  accept(input: AcceptedConversationEvent): void;
  typing(session: AcceptedConversationEvent["session"], participantId: string): void;
  hasSession(sessionKey: string): boolean;
}>;

export class DiscordConversationController implements DiscordGatewayPort {
  readonly #allowedChannelIds: ReadonlySet<string>;

  constructor(
    private readonly conversation: ConversationInput,
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
    const session = createDiscordConversationSession(event.scope);
    const accepted = shouldAcceptMessage({
      scope: event.scope,
      authorId: event.message.author.id,
      lunaUserId: this.lunaUserId,
      mentionsLuna: event.message.mentions.users.some((user) => user.id === this.lunaUserId),
      allowDm: this.allowDm,
      allowedChannelIds: this.#allowedChannelIds,
      lunaIsThreadMember: event.lunaIsThreadMember,
      sessionExists: this.conversation.hasSession(session.key),
    });
    if (accepted) {
      this.conversation.accept({
        session,
        event: createDiscordMessageEvent(event.scope, event.message),
      });
      this.onAccepted(event);
    }
  }

  onTyping(event: DiscordGatewayTyping): void {
    if (event.isHuman) {
      this.conversation.typing(createDiscordConversationSession(event.scope), event.userId);
    }
  }
}
