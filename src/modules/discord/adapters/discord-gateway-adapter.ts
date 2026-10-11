import { Client, GatewayIntentBits, Partials } from "discord.js";

import type { DiscordGatewayPort } from "../ports/discord-gateway-port";
import { toDiscordGatewayMessage, toDiscordGatewayTyping } from "./discord-message-adapter";

type DiscordGatewayEvent = "messageCreate" | "typingStart";
type DiscordGatewayListener = (payload: unknown) => void;

export type DiscordGatewayEventClient = Readonly<{
	on(event: DiscordGatewayEvent, listener: DiscordGatewayListener): unknown;
	off(event: DiscordGatewayEvent, listener: DiscordGatewayListener): unknown;
}>;

export function createDiscordGatewayClient(): Client {
	return new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.GuildMessageTyping,
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.DirectMessageTyping,
			GatewayIntentBits.MessageContent,
		],
		partials: [Partials.Channel],
	});
}

export class DiscordGatewayAdapter {
	readonly #messageListener: DiscordGatewayListener;
	readonly #typingListener: DiscordGatewayListener;

	constructor(
		private readonly client: DiscordGatewayEventClient,
		private readonly port: DiscordGatewayPort,
	) {
		this.#messageListener = (message) => {
			this.#dispatch("messageCreate", () => {
				this.port.onMessage(toDiscordGatewayMessage(message));
			});
		};
		this.#typingListener = (typing) => {
			this.#dispatch("typingStart", () => {
				this.port.onTyping(toDiscordGatewayTyping(typing));
			});
		};
	}

	start(): void {
		this.client.on("messageCreate", this.#messageListener);
		this.client.on("typingStart", this.#typingListener);
	}

	stop(): void {
		this.client.off("messageCreate", this.#messageListener);
		this.client.off("typingStart", this.#typingListener);
	}

	#dispatch(event: DiscordGatewayEvent, operation: () => void): void {
		try {
			operation();
		} catch (error: unknown) {
			this.port.onError(error, event);
		}
	}
}
