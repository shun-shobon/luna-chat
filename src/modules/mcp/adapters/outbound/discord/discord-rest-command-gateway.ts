import { REST, Routes } from "discord.js";

import type { DiscordCommandGateway } from "../../../ports/outbound/discord-command-gateway-port";

export function createDiscordRestCommandGateway(
  rest: Pick<REST, "post" | "put">,
): DiscordCommandGateway {
  return {
    addReaction: async ({ channelId, emoji, messageId }) => {
      const trimmedEmoji = emoji.trim();
      if (trimmedEmoji.length === 0) {
        throw new Error("emoji must not be empty.");
      }

      await rest.put(Routes.channelMessageOwnReaction(channelId, messageId, trimmedEmoji));

      return {
        ok: true,
      };
    },
    sendMessage: async ({ channelId, replyToMessageId, text }) => {
      const trimmedText = text.trim();
      if (trimmedText.length === 0) {
        throw new Error("text must not be empty.");
      }

      const trimmedReplyToMessageId = replyToMessageId?.trim();
      if (replyToMessageId !== undefined && !trimmedReplyToMessageId) {
        throw new Error("replyToMessageId must not be empty.");
      }

      await rest.post(Routes.channelMessages(channelId), {
        body: {
          allowed_mentions: {
            parse: [],
            ...(trimmedReplyToMessageId ? { replied_user: true } : {}),
          },
          content: trimmedText,
          ...(trimmedReplyToMessageId
            ? {
                message_reference: {
                  fail_if_not_exists: false,
                  message_id: trimmedReplyToMessageId,
                },
              }
            : {}),
        },
      });

      return {
        ok: true,
      };
    },
    sendTyping: async (channelId) => {
      await rest.post(Routes.channelTyping(channelId));
    },
  };
}
