import { describe, expect, it } from "vitest";

import {
  formatAddReactionContent,
  formatGetGuildEmojiContent,
  formatGetUserDetailContent,
  formatListGuildEmojisContent,
  formatListChannelsContent,
  formatReadMessageHistoryContent,
  formatSendMessageContent,
  formatStartTypingContent,
} from "./discord-mcp-response-text";

describe("discord-mcp-response-text", () => {
  it("read_message_history のレスポンスを整形する", () => {
    const text = formatReadMessageHistoryContent({
      channelId: "channel-1",
      messages: [
        {
          attachments: [
            {
              id: "att-1",
              name: "memo.txt",
              url: "https://example.com/memo.txt",
            },
          ],
          authorId: "user-1",
          authorIsBot: false,
          authorName: "Alice",
          content: "old",
          createdAt: "2026-01-01 09:00:00 JST",
          id: "message-1",
        },
        {
          attachments: [],
          authorId: "user-2",
          authorIsBot: false,
          authorName: "Bob",
          content: "new",
          createdAt: "2026-01-01 09:01:00 JST",
          id: "message-2",
          reactions: [
            {
              count: 1,
              emoji: "👍",
              selfReacted: true,
            },
          ],
          stickers: [
            {
              description: "sticker description",
              format: "png",
              guildId: "guild-1",
              id: "sticker-1",
              name: "wave",
              url: "https://media.discordapp.net/stickers/sticker-1.png",
            },
          ],
        },
      ],
    });

    expect(text).toMatchSnapshot();
  });

  it("他ツールのレスポンスを整形する", () => {
    expect(
      formatSendMessageContent({
        channelId: "channel-1",
        replyToMessageId: "reply-1",
      }),
    ).toMatchSnapshot("send_message");

    expect(
      formatAddReactionContent({
        emoji: "👍",
        messageId: "message-1",
        userId: "user-1",
      }),
    ).toMatchSnapshot("add_reaction");

    expect(
      formatStartTypingContent({
        alreadyRunning: false,
        channelId: "channel-1",
      }),
    ).toMatchSnapshot("start_typing");

    expect(
      formatListChannelsContent({
        channels: [
          {
            guildId: "guild-1",
            guildName: "Guild Name",
            id: "channel-1",
            name: "general",
          },
        ],
      }),
    ).toMatchSnapshot("list_channels");

    expect(
      formatGetUserDetailContent({
        user: {
          avatarUrl: "https://cdn.discordapp.com/avatars/user-1/display-avatar.png",
          bannerUrl: "https://cdn.discordapp.com/banners/user-1/display-banner.png",
          bot: false,
          displayName: "Alice",
          globalName: "Alice Global",
          id: "user-1",
          nickname: null,
          username: "alice",
        },
      }),
    ).toMatchSnapshot("get_user_detail");

    expect(
      formatListGuildEmojisContent({
        emojis: [
          {
            animated: true,
            guildId: "guild-1",
            id: "emoji-1",
            mention: "<a:party:emoji-1>",
            name: "party",
            url: "https://cdn.discordapp.com/emojis/emoji-1.gif",
          },
        ],
        guildId: "guild-1",
      }),
    ).toMatchSnapshot("list_guild_emojis");

    expect(
      formatGetGuildEmojiContent({
        emoji: {
          animated: false,
          guildId: "guild-1",
          id: "emoji-2",
          mention: "<:luna:emoji-2>",
          name: "luna",
          url: "https://cdn.discordapp.com/emojis/emoji-2.webp",
        },
      }),
    ).toMatchSnapshot("get_guild_emoji");
  });
});
