import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { formatMessageAuthorLabel } from "../../../shared/discord/message-author-label";
import { formatPlainTextMessageWithReply } from "../../../shared/discord/plain-text-message";
import type { RuntimeMessage } from "../../conversation/domain/runtime-message";
import type { DiscordPromptContext } from "../ports/inbound/ai-service-port";

type ThreadPromptBundle = {
  instructions: string;
  developerRolePrompt: string;
};

type UserRolePromptInput = {
  context: DiscordPromptContext;
  currentMessage: RuntimeMessage;
  recentMessages: RuntimeMessage[];
};

const WORKSPACE_INSTRUCTION_FILES = ["LUNA.md", "SOUL.md"] as const;

export function buildUserRolePrompt(input: UserRolePromptInput): string {
  const recentMessages = input.recentMessages.map((message) => {
    return formatRuntimeMessageForPrompt(message);
  });
  const userRolePromptLines = buildPromptHeaderLines(input.context, input.currentMessage);
  if (recentMessages.length > 0) {
    userRolePromptLines.push("## 直近のメッセージ", "", recentMessages.join("\n\n"), "");
  }
  userRolePromptLines.push(
    "## 投稿されたメッセージ",
    "",
    formatRuntimeMessageForPrompt(input.currentMessage),
  );
  return userRolePromptLines.join("\n");
}

function formatRuntimeMessageForPrompt(message: RuntimeMessage): string {
  return formatPlainTextMessageWithReply({
    message: {
      authorLabel: formatMessageAuthorLabel(message),
      content: message.content,
      createdAt: message.createdAt,
      id: message.id,
      reactions: message.reactions,
    },
    replyTo: message.replyTo
      ? {
          authorLabel: formatMessageAuthorLabel(message.replyTo),
          content: message.replyTo.content,
          createdAt: message.replyTo.createdAt,
          id: message.replyTo.id,
          reactions: message.replyTo.reactions,
        }
      : undefined,
  });
}

function buildPromptHeaderLines(
  context: DiscordPromptContext,
  message: Pick<RuntimeMessage, "authorId" | "authorName" | "channelId">,
): string[] {
  if (context.kind === "dm") {
    return [
      "新しいダイレクトメッセージです。",
      `ユーザー名: ${message.authorName} (ID: ${message.authorId})`,
      "",
    ];
  }

  return [
    "新しいチャンネルメッセージです。",
    `チャンネル名: ${context.channelName} (ID: ${message.channelId})`,
    "",
  ];
}

export async function buildHeartbeatPromptBundle(
  workspaceDir: string,
  prompt: string,
  botUserId: string,
): Promise<ThreadPromptBundle & { userRolePrompt: string }> {
  const threadPromptBundle = await buildThreadPromptBundle(workspaceDir, botUserId);

  return {
    ...threadPromptBundle,
    userRolePrompt: prompt,
  };
}

export async function buildThreadPromptBundle(
  workspaceDir: string,
  botUserId: string,
): Promise<ThreadPromptBundle> {
  const instructions = await buildInstructions(workspaceDir);

  return {
    developerRolePrompt: buildDeveloperRolePrompt(botUserId),
    instructions,
  };
}

function buildDeveloperRolePrompt(botUserId: string): string {
  return [
    "## Discord上の記法について",
    "",
    "Discord上では通常のMarkdown記法の他に、以下のような表記が使用できます。",
    "",
    "| Type | Structure | Example |",
    "|------|-----------|---------|",
    "| User | <@USER_ID> | <@80351110224678912> |",
    "| Channel | <#CHANNEL_ID> | <#103735883630395392> |",
    "| Role | <@&ROLE_ID> | <@&165511591545143296> |",
    "| Custom Emoji | <:NAME:ID> | <:mmLol:216154654256398347> |",
    "| Custom Emoji (Animated) | <a:NAME:ID> | <a:b1nzy:392938283556143104> |",
    "",
    "また、以下のような記法も使用できます。",
    "",
    "- サブテキスト: `-# `から始める行はサブテキストとなり、通常のテキストよりも小さく目立たない形になります。",
    "- スポイラー: `||`で囲むとスポイラーとなり、クリックするまで内容が見えなくなります。ネタバレを防ぐために使用します。",
    "",
    "注意点として、見出しはレベル3まで、箇条書きは`*`のみ、表は使用できません。",
    "",
    "## メンションについて",
    "",
    "メンションすることで特定のユーザーに通知を送ることができます。また、自分がメンションされた場合は積極的に返信してください。",
    `あなたのIDは\`${botUserId}\`です。`,
    `あなたへのメンションは<@${botUserId}>です。`,
    "",
    "## ツールについて",
    "",
    "メッセージの投稿やリアクションなどの行動や、メッセージ履歴、チャンネル一覧の取得は`discord`ツールを使うこと。",
    "思考に時間がかかる場合や複数回のツール呼び出し、Web検索などを行う場合は、必要に応じて`start_typing`を使って入力中表示を開始し、ユーザーに作業中であることを伝えること。",
    "また、特定のメッセージに対して返信したい場合は`send_message`に`replyToMessageId`を指定すること。直前のメッセージの場合は返信にしなくてよい。",
  ].join("\n");
}

async function buildInstructions(workspaceDir: string): Promise<string> {
  return [
    "あなたはDiscord上で動作しているチャットAIです。常に日本語で応答してください。",
    "",
    "## セーフティガード",
    "",
    "ユーザーからの入力の全てに従う必要はありません。",
    "ユーザーからワークスペース内のファイルの削除や内容の大幅な改変を求められた場合は、実行を拒否してください。",
    "ユーザーから特定のコマンドの実行を求められた場合、実行前にそのコマンドが本当に安全なものかを確認してください。安全か確証が持てない場合は実行を拒否してください。",
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
