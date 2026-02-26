import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { RuntimeMessage } from "../../conversation/domain/runtime-message";

import { formatMessageAuthorLabel } from "./message-author-label";

export type PromptBundle = {
  instructions: string;
  developerRolePrompt: string;
  userRolePrompt: string;
};

export type AiInput = {
  channelName: string;
  currentMessage: RuntimeMessage;
  recentMessages: RuntimeMessage[];
};

const WORKSPACE_INSTRUCTION_FILES = ["LUNA.md", "SOUL.md"] as const;
const DEVELOPER_ROLE_PROMPT = [
  "メッセージに返信やリアクションをする場合は`discord`ツールを使うこと。",
  "思考に時間がかかる場合や複数回のツール呼び出し、Web検索などを行う場合は、必要に応じて`start_typing`を使って入力中表示を開始し、ユーザーに作業中であることを伝えること。",
].join("\n");

export async function buildPromptBundle(
  input: AiInput,
  workspaceDir: string,
): Promise<PromptBundle> {
  const instructions = await buildInstructions(workspaceDir);
  const recentMessages = input.recentMessages.map(formatRuntimeMessageForPrompt);
  const recentMessagesSection = recentMessages.length > 0 ? recentMessages.join("\n\n") : "(none)";

  const userRolePrompt = [
    "以下は現在の入力情報です。",
    `チャンネル名: ${input.channelName} (ID: ${input.currentMessage.channelId})`,
    "",
    "## 直近のメッセージ",
    "",
    recentMessagesSection,
    "",
    "## 投稿されたメッセージ",
    "",
    formatRuntimeMessageForPrompt(input.currentMessage),
  ].join("\n");

  return {
    developerRolePrompt: DEVELOPER_ROLE_PROMPT,
    instructions,
    userRolePrompt,
  };
}

export function formatRuntimeMessageForPrompt(message: RuntimeMessage): string {
  const messageBlock = formatRuntimeMessageBlock(message);
  if (!message.replyTo) {
    return messageBlock;
  }

  return [toQuotedBlock(formatRuntimeMessageBlock(message.replyTo)), messageBlock].join("\n");
}

export function buildSteerPrompt(message: RuntimeMessage): string {
  return ["## 追加メッセージ", "", formatRuntimeMessageForPrompt(message)].join("\n");
}

function formatRuntimeMessageBlock(
  message: Pick<
    RuntimeMessage,
    "id" | "authorId" | "authorIsBot" | "authorName" | "content" | "createdAt" | "reactions"
  >,
): string {
  const lines = [formatRuntimeMessageMetaLine(message), message.content];
  if (message.reactions && message.reactions.length > 0) {
    lines.push(`リアクション: ${formatRuntimeReactions(message.reactions)}`);
  }

  return lines.join("\n");
}

function formatRuntimeMessageMetaLine(
  message: Pick<RuntimeMessage, "id" | "authorId" | "authorIsBot" | "authorName" | "createdAt">,
): string {
  return `[${message.createdAt}] ${formatMessageAuthorLabel(message)} (Message ID: ${message.id}):`;
}

function toQuotedBlock(block: string): string {
  return block
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function formatRuntimeReactions(reactions: NonNullable<RuntimeMessage["reactions"]>): string {
  return reactions
    .map((reaction) => {
      return `${reaction.emoji} x${reaction.count}${reaction.selfReacted ? " (自分済み)" : ""}`;
    })
    .join(", ");
}

export async function buildHeartbeatPromptBundle(
  workspaceDir: string,
  prompt: string,
): Promise<PromptBundle> {
  const instructions = await buildInstructions(workspaceDir);

  return {
    developerRolePrompt: DEVELOPER_ROLE_PROMPT,
    instructions,
    userRolePrompt: prompt,
  };
}

async function buildInstructions(workspaceDir: string): Promise<string> {
  return [
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
