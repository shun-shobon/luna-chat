import { z } from "zod";

import { discordIdSchema } from "./discord-id";

export const conversationScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("guild_channel"),
    guildId: discordIdSchema,
    channelId: discordIdSchema,
  }),
  z.strictObject({
    kind: z.literal("guild_thread"),
    guildId: discordIdSchema,
    parentChannelId: discordIdSchema,
    threadId: discordIdSchema,
  }),
  z.strictObject({
    kind: z.literal("dm"),
    channelId: discordIdSchema,
    userId: discordIdSchema,
  }),
]);

export type ConversationScope = z.infer<typeof conversationScopeSchema>;

export function conversationScopeKey(scope: ConversationScope): string {
  switch (scope.kind) {
    case "guild_channel":
      return `guild_channel:${scope.guildId}:${scope.channelId}`;
    case "guild_thread":
      return `guild_thread:${scope.guildId}:${scope.parentChannelId}:${scope.threadId}`;
    case "dm":
      return `dm:${scope.channelId}:${scope.userId}`;
  }
}
