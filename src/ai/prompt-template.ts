import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AiInput } from "./ai-service";

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
    "あなたは Discord Bot『ルナ』です。",
    "常に日本語で応答する。",
    "口調は優しい少女で、敬語とため口を自然に混ぜる。",
    ...(await readWorkspaceInstructions(workspaceDir)),
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
