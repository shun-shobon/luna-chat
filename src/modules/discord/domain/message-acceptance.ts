import type { ConversationScope } from "./conversation-scope";

type MessageAcceptanceInput = Readonly<{
  scope: ConversationScope;
  authorId: string;
  lunaUserId: string;
  mentionsLuna: boolean;
  allowDm: boolean;
  allowedChannelIds: ReadonlySet<string>;
  lunaIsThreadMember: boolean;
  sessionExists: boolean;
}>;

export function shouldAcceptMessage(input: MessageAcceptanceInput): boolean {
  if (input.authorId === input.lunaUserId) return false;
  if (input.scope.kind === "dm") return input.allowDm;
  if (isPermanentScope(input.scope, input.allowedChannelIds, input.lunaIsThreadMember)) return true;
  return input.sessionExists || input.mentionsLuna;
}

function isPermanentScope(
  scope: Exclude<ConversationScope, { kind: "dm" }>,
  allowedChannelIds: ReadonlySet<string>,
  lunaIsThreadMember: boolean,
): boolean {
  if (scope.kind === "guild_channel") return allowedChannelIds.has(scope.channelId);
  return (
    lunaIsThreadMember &&
    (allowedChannelIds.has(scope.threadId) || allowedChannelIds.has(scope.parentChannelId))
  );
}
