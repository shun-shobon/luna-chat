import { z } from "zod";

import type { ConversationSession } from "../../conversation/domain/conversation-session";
import { lunaEventSchema, type LunaEvent } from "../../event/domain/luna-event";

import {
  conversationScopeKey,
  conversationScopeSchema,
  type ConversationScope,
} from "./conversation-scope";
import { discordMessageSchema, type DiscordMessage } from "./discord-message";

export const DISCORD_EVENT_SOURCE = "discord/main";
export const DISCORD_MESSAGE_CREATED_EVENT_TYPE = "discord.message.created.v1";

export const discordMessageEventDataSchema = z.strictObject({
  scope: conversationScopeSchema,
  message: discordMessageSchema,
});

export function createDiscordConversationSession(scope: ConversationScope): ConversationSession {
  const validatedScope = conversationScopeSchema.parse(scope);
  return {
    key: `discord:${conversationScopeKey(validatedScope)}`,
    source: DISCORD_EVENT_SOURCE,
    context: validatedScope,
  };
}

export function createDiscordMessageEvent(
  scope: ConversationScope,
  message: DiscordMessage,
): LunaEvent {
  const session = createDiscordConversationSession(scope);
  const validatedMessage = discordMessageSchema.parse(message);
  return lunaEventSchema.parse({
    id: validatedMessage.id,
    type: DISCORD_MESSAGE_CREATED_EVENT_TYPE,
    source: DISCORD_EVENT_SOURCE,
    subject: session.key,
    occurredAt: validatedMessage.timestamp,
    data: {
      scope: session.context,
      message: validatedMessage,
    },
  });
}
