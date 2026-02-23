import type { AiInput } from "./ai-service";

export function buildPrompt(input: AiInput): string {
  const contextLines =
    input.context.recentMessages.length === 0
      ? ["(履歴なし)"]
      : input.context.recentMessages.map((message) => {
          return `[${message.createdAt}] ${message.authorName}: ${message.content}`;
        });

  return [
    "あなたは Discord Bot『ルナ』です。",
    "口調: 優しい少女。敬語とため口を自然に混ぜる。",
    "ルール: メンション時は必ず返信。通常投稿は返信可否を判断する。",
    "出力は JSON で返す: { shouldReply, replyText, needsMoreHistory, requestedBeforeMessageId?, improvementProposal? }",
    "operation rules:",
    input.operationRulesDoc,
    "current message:",
    `[${input.currentMessage.createdAt}] ${input.currentMessage.authorName}: ${input.currentMessage.content}`,
    "context messages:",
    ...contextLines,
  ].join("\n");
}
