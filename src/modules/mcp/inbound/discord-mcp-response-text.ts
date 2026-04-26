import type { RuntimeReaction } from "../../../shared/discord/runtime-reaction";
import { formatXmlMessageBlock } from "../../../shared/discord/xml-message";

type ReadMessageHistoryResult = {
  channelId: string;
  messages: Array<{
    attachments: Array<{
      id: string;
      name: string | null;
      url: string;
    }>;
    authorId: string;
    authorIsBot: boolean;
    authorName: string;
    content: string;
    createdAt: string;
    id: string;
    reactions?: RuntimeReaction[];
  }>;
};

type ListChannelsResult = {
  channels: Array<{
    guildId: string | null;
    guildName: string | null;
    id: string;
    name: string;
  }>;
};

type GetUserDetailResult = {
  user: {
    avatar: string | null;
    banner: string | null;
    bot: boolean;
    displayName: string;
    globalName: string | null;
    id: string;
    nickname: string | null;
    username: string;
  } | null;
};

export function formatReadMessageHistoryContent(payload: ReadMessageHistoryResult): string {
  if (payload.messages.length === 0) {
    return `<luna_input source="read_message_history" channel_id="${payload.channelId}">\n  <messages count="0" />\n</luna_input>`;
  }

  return [
    `<luna_input source="read_message_history" channel_id="${payload.channelId}">`,
    `  <messages count="${payload.messages.length}">`,
    ...payload.messages.map((message) => {
      return formatXmlMessageBlock(
        {
          attachments: message.attachments,
          authorId: message.authorId,
          authorIsBot: message.authorIsBot,
          authorName: message.authorName,
          channelId: payload.channelId,
          content: message.content,
          createdAt: message.createdAt,
          id: message.id,
          reactions: message.reactions,
        },
        "    ",
      );
    }),
    `  </messages>`,
    `</luna_input>`,
  ].join("\n");
}

export function formatSendMessageContent(_input: {
  channelId?: string;
  filePaths?: readonly string[];
  replyToMessageId?: string;
  userId?: string;
}): string {
  return "OK";
}

export function formatAddReactionContent(_input: {
  channelId?: string;
  emoji: string;
  messageId: string;
  userId?: string;
}): string {
  return "OK";
}

export function formatStartTypingContent(_input: {
  alreadyRunning: boolean;
  channelId?: string;
  userId?: string;
}): string {
  return "OK";
}

export function formatListChannelsContent(payload: ListChannelsResult): string {
  if (payload.channels.length === 0) {
    return "チャンネルはありません。";
  }

  const lines = payload.channels.map((channel) => {
    const guildLabel =
      channel.guildId === null
        ? "Guild: なし"
        : `Guild: ${channel.guildName ?? "不明"} (ID: ${channel.guildId})`;
    return `- ${channel.name} (ID: ${channel.id}, ${guildLabel})`;
  });

  return lines.join("\n");
}

export function formatGetUserDetailContent(payload: GetUserDetailResult): string {
  if (!payload.user) {
    return "ユーザー情報を取得できませんでした。";
  }

  return [
    `表示名: ${payload.user.displayName}`,
    `ユーザー名: ${payload.user.username}`,
    `ユーザーID: ${payload.user.id}`,
    `Bot: ${payload.user.bot ? "true" : "false"}`,
    `ニックネーム: ${payload.user.nickname ?? "なし"}`,
    `グローバル名: ${payload.user.globalName ?? "なし"}`,
    `アバター: ${payload.user.avatar ?? "なし"}`,
    `バナー: ${payload.user.banner ?? "なし"}`,
  ].join("\n");
}
