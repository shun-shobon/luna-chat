export function formatMessageAuthorLabel(input: {
  authorId: string;
  authorIsBot: boolean;
  authorName: string;
}): string {
  const botSuffix = input.authorIsBot ? " (Bot)" : "";
  return `${input.authorName}${botSuffix} (ID: ${input.authorId})`;
}
