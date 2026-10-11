import { basename } from "node:path";

import { AttachmentBuilder } from "discord.js";
import type { MessageCreateOptions } from "discord.js";

import type { TypingLeaseRegistry } from "../application/typing-lease-registry";
import type {
	DiscordAction,
	DiscordEmoji,
	DiscordTarget,
	SendFile,
} from "../domain/discord-action";
import type { DiscordActionPort, DiscordActionSuccess } from "../ports/discord-action-port";

type SentMessage = Readonly<{ id: string }>;

export type SendableChannel = Readonly<{
	id: string;
	send(options: MessageCreateOptions): Promise<SentMessage>;
	sendTyping(): Promise<void>;
}>;

type MessageHandle = Readonly<{
	reply(options: MessageCreateOptions): Promise<SentMessage>;
	react(emoji: string): Promise<unknown>;
	reactions: Readonly<{
		resolve(emoji: string): Readonly<{ users: Readonly<{ remove(): Promise<unknown> }> }> | null;
	}>;
}>;

export type MessageChannel = Readonly<{
	id: string;
	messages: Readonly<{ fetch(messageId: string): Promise<MessageHandle> }>;
}>;

type FetchedChannel = Readonly<{
	isSendable(): this is SendableChannel;
	isTextBased(): this is MessageChannel;
}>;

export type DiscordActionClient = Readonly<{
	channels: Readonly<{ fetch(channelId: string): Promise<FetchedChannel | null> }>;
	users: Readonly<{ createDM(userId: string): Promise<SendableChannel> }>;
}>;

export class DiscordActionAdapter implements DiscordActionPort {
	constructor(
		private readonly client: DiscordActionClient,
		private readonly resolveFile: (file: SendFile) => Promise<SendFile>,
		private readonly typing: TypingLeaseRegistry,
	) {}

	async execute(action: DiscordAction, ownerId: string): Promise<DiscordActionSuccess> {
		switch (action.kind) {
			case "send_message": {
				const channel = await this.#resolveTarget(action.target);
				const sent = await channel.send(await this.#messageOptions(action.content, action.files));
				return success(action.kind, { channelId: channel.id, messageId: sent.id });
			}
			case "reply_message": {
				const message = await this.#fetchMessage(action.channelId, action.messageId);
				const sent = await message.reply(await this.#messageOptions(action.content, action.files));
				return success(action.kind, { channelId: action.channelId, messageId: sent.id });
			}
			case "add_reaction": {
				const message = await this.#fetchMessage(action.channelId, action.messageId);
				await message.react(emojiIdentifier(action.emoji));
				return success(action.kind, { channelId: action.channelId, messageId: action.messageId });
			}
			case "remove_reaction": {
				const message = await this.#fetchMessage(action.channelId, action.messageId);
				const reaction = message.reactions.resolve(emojiIdentifier(action.emoji));
				if (reaction == null) throw new Error("Luna reaction was not found");
				await reaction.users.remove();
				return success(action.kind, { channelId: action.channelId, messageId: action.messageId });
			}
			case "start_typing": {
				const channel = await this.#resolveTarget(action.target);
				await this.typing.start({ ownerId, channelId: channel.id }, async () => {
					await channel.sendTyping();
				});
				return success(action.kind, { channelId: channel.id });
			}
			case "stop_typing": {
				const channel = await this.#resolveTarget(action.target);
				this.typing.stop({ ownerId, channelId: channel.id });
				return success(action.kind, { channelId: channel.id });
			}
			default: {
				const unknownAction: never = action;
				throw new Error(`Unknown Discord action: ${JSON.stringify(unknownAction)}`);
			}
		}
	}

	releaseTyping(ownerId: string): Promise<void> {
		this.typing.releaseOwner(ownerId);
		return Promise.resolve();
	}

	async #resolveTarget(target: DiscordTarget): Promise<SendableChannel> {
		if (target.kind === "dm_user") return await this.client.users.createDM(target.userId);
		const channel = await this.client.channels.fetch(target.channelId);
		if (channel == null || !channel.isSendable()) {
			throw new Error(`Discord channel is not sendable: ${target.channelId}`);
		}
		return channel;
	}

	async #fetchMessage(channelId: string, messageId: string): Promise<MessageHandle> {
		const channel = await this.client.channels.fetch(channelId);
		if (channel == null || !channel.isTextBased()) {
			throw new Error(`Discord channel does not contain messages: ${channelId}`);
		}
		return await channel.messages.fetch(messageId);
	}

	async #messageOptions(
		content: string | undefined,
		files: readonly SendFile[] | undefined,
	): Promise<MessageCreateOptions> {
		const resolvedFiles =
			files === undefined
				? undefined
				: await Promise.all(files.map(async (file) => await this.resolveFile(file)));
		return {
			...(content === undefined ? {} : { content }),
			...(resolvedFiles === undefined ? {} : { files: resolvedFiles.map(toAttachmentBuilder) }),
		};
	}
}

function toAttachmentBuilder(file: SendFile): AttachmentBuilder {
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
