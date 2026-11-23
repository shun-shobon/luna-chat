import { Client, GatewayIntentBits, Partials } from "discord.js";

import type { DiscordGatewayEventName, DiscordGatewayPort } from "../ports/discord-gateway-port";
import {
	toDiscordGatewayMessage,
	toDiscordGatewayMessageDelete,
	toDiscordGatewayMessageEdit,
	toDiscordGatewayReaction,
	toDiscordGatewayTyping,
} from "./discord-message-adapter";

type DiscordGatewayListener = (...payload: unknown[]) => void;

export type DiscordGatewayEventClient = Readonly<{
	on(event: DiscordGatewayEventName, listener: DiscordGatewayListener): unknown;
	off(event: DiscordGatewayEventName, listener: DiscordGatewayListener): unknown;
}>;

export function createDiscordGatewayClient(options: Readonly<{ voice: boolean }>): Client {
	return new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.GuildMessageReactions,
			GatewayIntentBits.GuildMessageTyping,
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.DirectMessageReactions,
			GatewayIntentBits.DirectMessageTyping,
			GatewayIntentBits.MessageContent,
			...(options.voice ? [GatewayIntentBits.GuildVoiceStates] : []),
		],
		// 初回コンテキストの過去ログはキャッシュしないため、Message と Reaction の partial がないとその編集・削除・リアクションが届かない。
		partials: [Partials.Channel, Partials.Message, Partials.Reaction],
	});
}

export class DiscordGatewayAdapter {
	readonly #listeners: ReadonlyMap<DiscordGatewayEventName, DiscordGatewayListener>;

	constructor(
		private readonly client: DiscordGatewayEventClient,
		private readonly port: DiscordGatewayPort,
	) {
		this.#listeners = new Map<DiscordGatewayEventName, DiscordGatewayListener>([
			[
				"messageCreate",
				(message) => {
					this.#dispatch("messageCreate", () => {
						this.port.onMessage(toDiscordGatewayMessage(message));
					});
				},
			],
			[
				"messageUpdate",
				(oldMessage, newMessage) => {
					this.#dispatch("messageUpdate", () => {
						const edit = toDiscordGatewayMessageEdit(oldMessage, newMessage);
						if (edit != null) this.port.onMessageEdit(edit);
					});
				},
			],
			[
				"messageDelete",
				(message) => {
					this.#dispatch("messageDelete", () => {
						this.port.onMessageDelete(toDiscordGatewayMessageDelete(message));
					});
				},
			],
			[
				"messageReactionAdd",
				(reaction, user) => {
					this.#dispatch("messageReactionAdd", () => {
						this.port.onReaction(toDiscordGatewayReaction("added", reaction, user));
					});
				},
			],
			[
				"messageReactionRemove",
				(reaction, user) => {
					this.#dispatch("messageReactionRemove", () => {
						this.port.onReaction(toDiscordGatewayReaction("removed", reaction, user));
					});
				},
			],
			[
				"typingStart",
				(typing) => {
					this.#dispatch("typingStart", () => {
						this.port.onTyping(toDiscordGatewayTyping(typing));
					});
				},
			],
		]);
	}

	start(): void {
		for (const [event, listener] of this.#listeners) this.client.on(event, listener);
	}

	stop(): void {
		for (const [event, listener] of this.#listeners) this.client.off(event, listener);
	}

	#dispatch(event: DiscordGatewayEventName, operation: () => void): void {
		try {
			operation();
		} catch (error: unknown) {
			this.port.onError(error, event);
		}
	}
}
