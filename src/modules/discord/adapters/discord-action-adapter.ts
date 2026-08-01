import { basename } from "node:path";

import { AttachmentBuilder, type MessageCreateOptions } from "discord.js";

import { TypingLeaseRegistry } from "../application/typing-lease-registry";
import {
  discordActionSchema,
  type DiscordAction,
  type DiscordEmoji,
  type DiscordTarget,
  type SendFile,
} from "../domain/discord-action";
import { discordIdSchema } from "../domain/discord-id";
import type { DiscordActionPort, DiscordActionSuccess } from "../ports/discord-action-port";
import type { ResolvedSendFile, SendFileResolverPort } from "../ports/send-file-resolver-port";

export type DiscordActionClient = Readonly<{
  channels: Readonly<{ fetch(channelId: string): Promise<unknown> }>;
  users: Readonly<{ createDM(userId: string): Promise<unknown> }>;
}>;

type SendableChannel = Readonly<{
  id: string;
  send(options: MessageCreateOptions): Promise<unknown>;
  sendTyping(): Promise<void>;
}>;

type MessageChannel = SendableChannel &
  Readonly<{
    messages: Readonly<{ fetch(messageId: string): Promise<unknown> }>;
  }>;

type DiscordMessageHandle = Readonly<{
  reply(options: MessageCreateOptions): Promise<unknown>;
  react(emoji: string): Promise<unknown>;
  reactions: Readonly<{ resolve(emoji: string): unknown }>;
}>;

type DiscordReactionHandle = Readonly<{
  users: Readonly<{ remove(): Promise<unknown> }>;
}>;

export class DiscordActionAdapter implements DiscordActionPort {
  constructor(
    private readonly client: DiscordActionClient,
    private readonly files: SendFileResolverPort,
    private readonly typing: TypingLeaseRegistry,
  ) {}

  async execute(actionInput: DiscordAction, ownerId: string): Promise<DiscordActionSuccess> {
    const action = discordActionSchema.parse(actionInput);
    switch (action.kind) {
      case "send_message": {
        const channel = await this.resolveTarget(action.target);
        const sent = await channel.send(await this.messageOptions(action.content, action.files));
        return success(action.kind, { channelId: channel.id, messageId: messageId(sent) });
      }
      case "reply_message": {
        const channel = await this.fetchMessageChannel(action.channelId);
        const message = await this.fetchMessage(channel, action.messageId);
        const sent = await message.reply(await this.messageOptions(action.content, action.files));
        return success(action.kind, { channelId: channel.id, messageId: messageId(sent) });
      }
      case "add_reaction": {
        const channel = await this.fetchMessageChannel(action.channelId);
        const message = await this.fetchMessage(channel, action.messageId);
        await message.react(emojiIdentifier(action.emoji));
        return success(action.kind, { channelId: channel.id, messageId: action.messageId });
      }
      case "remove_reaction": {
        const channel = await this.fetchMessageChannel(action.channelId);
        const message = await this.fetchMessage(channel, action.messageId);
        const reaction = message.reactions.resolve(emojiIdentifier(action.emoji));
        if (!isReactionHandle(reaction)) throw new Error("Luna reaction was not found");
        await reaction.users.remove();
        return success(action.kind, { channelId: channel.id, messageId: action.messageId });
      }
      case "start_typing": {
        const channel = await this.resolveTarget(action.target);
        await this.typing.start({ ownerId, channelId: channel.id }, async () => {
          await channel.sendTyping();
        });
        return success(action.kind, { channelId: channel.id });
      }
      case "stop_typing": {
        const channel = await this.resolveTarget(action.target);
        this.typing.stop({ ownerId, channelId: channel.id });
        return success(action.kind, { channelId: channel.id });
      }
    }
  }

  async releaseTyping(ownerId: string): Promise<void> {
    this.typing.releaseOwner(ownerId);
  }

  async #resolveChannelId(target: DiscordTarget): Promise<string> {
    if (target.kind === "channel") return target.channelId;
    const channel = await this.client.users.createDM(target.userId);
    return discordIdSchema.parse(readProperty(channel, "id"));
  }

  async resolveTarget(target: DiscordTarget): Promise<SendableChannel> {
    const channelId = await this.#resolveChannelId(target);
    const channel = await this.client.channels.fetch(channelId);
    if (!isSendableChannel(channel))
      throw new Error(`Discord channel is not sendable: ${channelId}`);
    return channel;
  }

  async fetchMessageChannel(channelId: string): Promise<MessageChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!isMessageChannel(channel)) {
      throw new Error(`Discord channel does not contain messages: ${channelId}`);
    }
    return channel;
  }

  async fetchMessage(
    channel: MessageChannel,
    messageIdValue: string,
  ): Promise<DiscordMessageHandle> {
    const message = await channel.messages.fetch(messageIdValue);
    if (!isMessageHandle(message))
      throw new Error(`Discord message is unavailable: ${messageIdValue}`);
    return message;
  }

  async messageOptions(
    content: string | undefined,
    files: readonly SendFile[] | undefined,
  ): Promise<MessageCreateOptions> {
    const resolvedFiles =
      files === undefined
        ? undefined
        : await Promise.all(files.map(async (file) => await this.files.resolve(file)));
    return {
      ...(content === undefined ? {} : { content }),
      ...(resolvedFiles === undefined ? {} : { files: resolvedFiles.map(toAttachmentBuilder) }),
    };
  }
}

function toAttachmentBuilder(file: ResolvedSendFile): AttachmentBuilder {
  return new AttachmentBuilder(file.path, {
    name: file.fileName ?? basename(file.path),
    ...(file.description === undefined ? {} : { description: file.description }),
  });
}

function emojiIdentifier(emoji: DiscordEmoji): string {
  return emoji.kind === "unicode" ? emoji.value : `${emoji.name ?? "_"}:${emoji.id}`;
}

function success(
  actionKind: DiscordAction["kind"],
  detail: Readonly<Record<string, string>>,
): DiscordActionSuccess {
  return { actionKind, detail };
}

function messageId(message: unknown): string {
  return discordIdSchema.parse(readProperty(message, "id"));
}

function readProperty(value: unknown, property: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, property) : undefined;
}

function hasMethod(value: unknown, method: string): boolean {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, method) === "function"
  );
}

function isSendableChannel(value: unknown): value is SendableChannel {
  return (
    discordIdSchema.safeParse(readProperty(value, "id")).success &&
    hasMethod(value, "send") &&
    hasMethod(value, "sendTyping")
  );
}

function isMessageChannel(value: unknown): value is MessageChannel {
  const messages = readProperty(value, "messages");
  return isSendableChannel(value) && hasMethod(messages, "fetch");
}

function isMessageHandle(value: unknown): value is DiscordMessageHandle {
  return (
    hasMethod(value, "reply") &&
    hasMethod(value, "react") &&
    typeof readProperty(value, "reactions") === "object" &&
    hasMethod(readProperty(value, "reactions"), "resolve")
  );
}

function isReactionHandle(value: unknown): value is DiscordReactionHandle {
  return (
    typeof readProperty(value, "users") === "object" &&
    hasMethod(readProperty(value, "users"), "remove")
  );
}
