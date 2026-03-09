import { basename } from "node:path";

import { AttachmentBuilder, type MessageCreateOptions } from "discord.js";
import { z } from "zod";

import type {
  DiscordCommandGateway,
  DiscordCommandTarget,
} from "../../../ports/outbound/discord-command-gateway-port";

type DiscordCommandClient = {
  channels: {
    fetch: (channelId: string) => Promise<unknown>;
  };
  users: {
    createDM: (userId: string) => Promise<{
      id: string;
    }>;
  };
};

type ReactableChannel = {
  messages: {
    react: (messageId: string, emoji: string) => Promise<void>;
  };
};

type SendableChannel = {
  send: (options: MessageCreateOptions) => Promise<unknown>;
};

type TypableChannel = {
  sendTyping: () => Promise<void>;
};

const dmChannelSchema = z.object({
  id: z.string().min(1),
});

export function createDiscordRestCommandGateway(
  client: DiscordCommandClient,
): DiscordCommandGateway {
  return {
    resolveChannelId: async (target) => {
      return await resolveChannelId({
        client,
        target,
      });
    },
    addReaction: async ({ channelId, emoji, messageId }) => {
      const trimmedEmoji = emoji.trim();
      if (trimmedEmoji.length === 0) {
        throw new Error("emoji must not be empty.");
      }

      const channel = await fetchTextChannel(client, channelId);
      if (!isReactableChannel(channel)) {
        throw new Error("channel does not support message reactions.");
      }
      await channel.messages.react(messageId, trimmedEmoji);

      return {
        ok: true,
      };
    },
    sendMessage: async ({ channelId, filePaths, replyToMessageId, text }) => {
      const trimmedText = text?.trim();
      if (text !== undefined && !trimmedText) {
        throw new Error("text must not be empty.");
      }

      const normalizedFilePaths = normalizeFilePaths(filePaths);
      const trimmedReplyToMessageId = replyToMessageId?.trim();
      if (replyToMessageId !== undefined && !trimmedReplyToMessageId) {
        throw new Error("replyToMessageId must not be empty.");
      }
      if (!trimmedText && normalizedFilePaths === undefined) {
        throw new Error("text or filePaths must be provided.");
      }

      const channel = await fetchTextChannel(client, channelId);
      if (!isSendableChannel(channel)) {
        throw new Error("channel does not support sending messages.");
      }
      const options: MessageCreateOptions = {
        allowedMentions: {
          parse: [],
          repliedUser: trimmedReplyToMessageId ? true : undefined,
        },
        reply: trimmedReplyToMessageId
          ? {
              failIfNotExists: false,
              messageReference: trimmedReplyToMessageId,
            }
          : undefined,
      };
      if (trimmedText) {
        options.content = trimmedText;
      }
      if (normalizedFilePaths) {
        options.files = normalizedFilePaths.map((filePath) => {
          return new AttachmentBuilder(filePath, {
            name: basename(filePath),
          });
        });
      }
      await channel.send(options);

      return {
        ok: true,
      };
    },
    sendTyping: async (channelId) => {
      const channel = await fetchTextChannel(client, channelId);
      if (!isTypableChannel(channel)) {
        throw new Error("channel does not support typing indicator.");
      }
      await channel.sendTyping();
    },
  };
}

async function resolveChannelId(input: {
  client: DiscordCommandClient;
  target: DiscordCommandTarget;
}): Promise<string> {
  if ("channelId" in input.target) {
    const trimmedChannelId = input.target.channelId.trim();
    if (!trimmedChannelId) {
      throw new Error("channelId must not be empty.");
    }
    return trimmedChannelId;
  }

  const trimmedUserId = input.target.userId.trim();
  if (!trimmedUserId) {
    throw new Error("userId must not be empty.");
  }

  const dmChannel = await input.client.users.createDM(trimmedUserId);
  const parsed = dmChannelSchema.safeParse(dmChannel);
  if (!parsed.success) {
    throw new Error("Failed to resolve DM channel.");
  }

  return parsed.data.id;
}

async function fetchTextChannel(client: DiscordCommandClient, channelId: string): Promise<unknown> {
  const trimmedChannelId = channelId.trim();
  if (!trimmedChannelId) {
    throw new Error("channelId must not be empty.");
  }

  const channel = await client.channels.fetch(trimmedChannelId);
  if (!isTextBasedChannel(channel)) {
    throw new Error("channel is not text-based.");
  }
  return channel;
}

function isTextBasedChannel(channel: unknown): channel is { isTextBased: () => boolean } {
  if (typeof channel !== "object" || channel === null) {
    return false;
  }

  const isTextBased = Reflect.get(channel, "isTextBased");
  if (typeof isTextBased !== "function") {
    return false;
  }

  return isTextBased.call(channel) === true;
}

function isSendableChannel(channel: unknown): channel is SendableChannel {
  if (typeof channel !== "object" || channel === null) {
    return false;
  }

  return typeof Reflect.get(channel, "send") === "function";
}

function isReactableChannel(channel: unknown): channel is ReactableChannel {
  if (typeof channel !== "object" || channel === null) {
    return false;
  }

  const messages = Reflect.get(channel, "messages");
  if (typeof messages !== "object" || messages === null) {
    return false;
  }

  return typeof Reflect.get(messages, "react") === "function";
}

function isTypableChannel(channel: unknown): channel is TypableChannel {
  if (typeof channel !== "object" || channel === null) {
    return false;
  }

  return typeof Reflect.get(channel, "sendTyping") === "function";
}

function normalizeFilePaths(filePaths: readonly string[] | undefined): string[] | undefined {
  if (filePaths === undefined) {
    return undefined;
  }
  if (filePaths.length === 0) {
    throw new Error("filePaths must not be empty.");
  }

  const normalized = filePaths.map((filePath) => {
    const trimmedFilePath = filePath.trim();
    if (trimmedFilePath.length === 0) {
      throw new Error("filePaths must not contain empty values.");
    }
    return trimmedFilePath;
  });

  return normalized;
}
