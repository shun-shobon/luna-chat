import type { JsonValue, LunaEvent } from "../../event/domain/luna-event";

export type ConversationSession = Readonly<{
  context: JsonValue;
  key: string;
  source: string;
}>;

export type AcceptedConversationEvent = Readonly<{
  event: LunaEvent;
  session: ConversationSession;
}>;
