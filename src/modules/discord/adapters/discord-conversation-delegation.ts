import type { AcceptedConversationEvent } from "../../conversation/domain/conversation-session";
import type { ConversationScope } from "../domain/conversation-scope";
import type { DiscordTarget } from "../domain/discord-action";
import {
  createDiscordConversationSession,
  createDiscordDelegatedEvent,
} from "../domain/discord-event";
import { discordIdSchema } from "../domain/discord-id";
import type { DiscordConversationDelegationPort } from "../ports/discord-conversation-delegation-port";

import type { DiscordActionClient } from "./discord-action-adapter";
import { toConversationScope } from "./discord-message-adapter";

export class DiscordConversationDelegation implements DiscordConversationDelegationPort {
  constructor(
    private readonly client: DiscordActionClient,
    private readonly input: Readonly<{
      accept(input: AcceptedConversationEvent): boolean;
      allowDm: boolean;
      createId(): string;
      now(): Date;
    }>,
  ) {}

  async delegate(target: DiscordTarget, brief: string): Promise<ConversationScope> {
    const scope = await this.#resolveScope(target);
    if (scope.kind === "dm" && !this.input.allowDm) {
      throw new Error("DM conversations are disabled by discord.allow_dm");
    }
    const accepted = this.input.accept({
      session: createDiscordConversationSession(scope),
      event: createDiscordDelegatedEvent({
        id: this.input.createId(),
        scope,
        brief,
        occurredAt: this.input.now(),
      }),
    });
    if (!accepted) throw new Error("Conversation intake is stopped");
    return scope;
  }

  async #resolveScope(target: DiscordTarget): Promise<ConversationScope> {
    if (target.kind === "dm_user") {
      const channel = await this.client.users.createDM(target.userId);
      const channelId = discordIdSchema.parse(
        typeof channel === "object" && channel != null ? Reflect.get(channel, "id") : undefined,
      );
      return { kind: "dm", channelId, userId: target.userId };
    }
    const channel = await this.client.channels.fetch(target.channelId);
    if (
      typeof channel !== "object" ||
      channel == null ||
      typeof Reflect.get(channel, "send") !== "function"
    ) {
      throw new Error(`Discord channel cannot hold a conversation: ${target.channelId}`);
    }
    return toConversationScope(channel);
  }
}
