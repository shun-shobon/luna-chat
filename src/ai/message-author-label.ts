import type { RuntimeMessage } from "../context/types";

type MessageAuthor = Pick<RuntimeMessage, "authorId" | "authorIsBot" | "authorName">;

export function formatMessageAuthorLabel(message: MessageAuthor): string {
  const botSuffix = message.authorIsBot ? " (Bot)" : "";
  return `${message.authorName}${botSuffix} (ID: ${message.authorId})`;
}
