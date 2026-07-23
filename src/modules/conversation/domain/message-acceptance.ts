import type { ConversationScope } from "../../discord/domain/conversation-scope";

type MessageAcceptanceInput = Readonly<{
  scope: ConversationScope;
  authorId: string;
  lunaUserId: string;
  mentionsLuna: boolean;
  allowDm: boolean;
  allowedChannelIds: ReadonlySet<string>;
  sessionExists: boolean;
}>;

export function shouldAcceptMessage(input: MessageAcceptanceInput): boolean {
  if (input.authorId === input.lunaUserId) return false;
  if (input.scope.kind === "dm") return input.allowDm;
  if (isPermanentScope(input.scope, input.allowedChannelIds)) return true;
  return input.sessionExists || input.mentionsLuna;
}

function isPermanentScope(
  scope: Exclude<ConversationScope, { kind: "dm" }>,
  allowedChannelIds: ReadonlySet<string>,
): boolean {
  if (scope.kind === "guild_channel") return allowedChannelIds.has(scope.channelId);
  return allowedChannelIds.has(scope.threadId) || allowedChannelIds.has(scope.parentChannelId);
}
