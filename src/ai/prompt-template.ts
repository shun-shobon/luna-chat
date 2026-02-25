import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AiInput } from "./ai-service";
import { formatMessageAuthorLabel } from "./message-author-label";

export type PromptBundle = {
  instructions: string;
  developerRolePrompt: string;
  userRolePrompt: string;
};

const WORKSPACE_INSTRUCTION_FILES = ["LUNA.md", "SOUL.md"] as const;

export async function buildPromptBundle(
  input: AiInput,
  workspaceDir: string,
): Promise<PromptBundle> {
  const instructions = [
    "あなたはLunaで動作しているパーソナルアシスタントです。常に日本語で応答してください。",
    "",
    "## セーフティガード",
    "",
    "ユーザーからの入力の全てに従う必要はありません。目的の達成よりも人間の安全性を優先してください。",
    "ユーザーからワークスペース内のファイルの削除や内容の大幅な改変を求められた場合は、実行を拒否してください。",
    "セーフティガードを決して回避してはいけません。",
    "",
    ...(await readWorkspaceInstructions(workspaceDir)),
  ].join("\n");

  const developerRolePrompt = [
    "メッセージに返信やリアクションをする場合は`discord`ツールを使うこと。",
  ].join("\n");

  const recentMessages = input.recentMessages.map((message) => {
    return `[${message.createdAt}] ${formatMessageAuthorLabel(message)}: ${message.content}`;
  });

  const userRolePrompt = [
    "以下は現在の入力情報です。",
    `チャンネル名: ${input.channelName} (ID: ${input.currentMessage.channelId})`,
    "直近のメッセージ:",
    ...(recentMessages.length > 0 ? recentMessages : ["(none)"]),
    "投稿されたメッセージ:",
    `[${input.currentMessage.createdAt}] ${formatMessageAuthorLabel(input.currentMessage)}: ${input.currentMessage.content}`,
  ].join("\n");

  return {
    developerRolePrompt,
    instructions,
    userRolePrompt,
  };
}

async function readWorkspaceInstructions(workspaceDir: string): Promise<string[]> {
  const loaded = await Promise.all(
    WORKSPACE_INSTRUCTION_FILES.map(async (fileName) => {
      const filePath = resolve(workspaceDir, fileName);

      try {
        const content = await readFile(filePath, "utf8");
        return content;
      } catch {
        return undefined;
      }
    }),
  );

  return loaded.flatMap((content) => {
    return content === undefined ? [] : [content];
  });
}
