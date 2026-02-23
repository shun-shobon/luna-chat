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
    "履歴が必要なら必ず MCP tool `fetch_discord_history` を使う。",
    "`fetch_discord_history` 引数: { channelId: string, beforeMessageId?: string, limit?: number }",
    "返信する場合は必ず `send_discord_reply` を使う。",
    "`send_discord_reply` 引数: { channelId: string, text: string }",
    "通常テキストをそのまま最終返信として扱わない。返信内容は必ず `send_discord_reply` の `text` に入れる。",
    "このターンでは user input の `channelId` をそのまま使うこと。",
    "必要なら user input の `currentMessageId` を `fetch_discord_history.beforeMessageId` に使ってよい。",
  ].join("\n");

  const userRolePrompt = [
    "以下は現在の入力情報です。",
    `forceReply: ${String(input.forceReply)}`,
    `contextFetchLimit: ${input.contextFetchLimit}`,
    `channelId: ${input.currentMessage.channelId}`,
    `currentMessageId: ${input.currentMessage.id}`,
    "currentMessage:",
    `[${input.currentMessage.createdAt}] ${input.currentMessage.authorName}: ${input.currentMessage.content}`,
  ].join("\n");

  return {
    developerRolePrompt,
    instructions,
    userRolePrompt,
  };
}
