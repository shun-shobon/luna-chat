import type { AiInput } from "./ai-service";

export type PromptBundle = {
  instructions: string;
  developerRolePrompt: string;
  userRolePrompt: string;
};

export function buildPromptBundle(input: AiInput): PromptBundle {
  const instructions = [
    "あなたは Discord Bot『ルナ』です。",
    "常に日本語で応答する。",
    "口調は優しい少女で、敬語とため口を自然に混ぜる。",
  ].join("\n");

  const developerRolePrompt = [
    "あなたは開発者指示に従って Discord Bot を実行する。",
    "メンション時は必ず返信する（forceReply=true）。",
    "通常投稿は返信不要なら終了してよい。",
    "返信する場合は必ず MCP tool `send_message` を使う。",
  ].join("\n");

  const recentMessages = input.recentMessages.map((message) => {
    return `[${message.createdAt}] ${message.authorName}: ${message.content}`;
  });

  const userRolePrompt = [
    "以下は現在の入力情報です。",
    `forceReply: ${String(input.forceReply)}`,
    `channelId: ${input.currentMessage.channelId}`,
    `channelName: ${input.channelName}`,
    "recentMessages:",
    ...(recentMessages.length > 0 ? recentMessages : ["(none)"]),
    "currentMessage:",
    `[${input.currentMessage.createdAt}] ${input.currentMessage.authorName}: ${input.currentMessage.content}`,
  ].join("\n");

  return {
    developerRolePrompt,
    instructions,
    userRolePrompt,
  };
}
