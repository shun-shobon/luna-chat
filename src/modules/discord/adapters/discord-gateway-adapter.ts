import { Client, GatewayIntentBits, Partials } from "discord.js";

import type { DiscordGatewayPort } from "../ports/discord-gateway-port";

import { toDiscordGatewayMessage, toDiscordGatewayTyping } from "./discord-message-adapter";

type DiscordGatewayEvent = "messageCreate" | "typingStart";
type DiscordGatewayListener = (payload: unknown) => void;

export interface DiscordGatewayEventClient {
  on(event: DiscordGatewayEvent, listener: DiscordGatewayListener): void;
  off(event: DiscordGatewayEvent, listener: DiscordGatewayListener): void;
}

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

export function createDiscordGatewayEventClient(client: Client): DiscordGatewayEventClient {
  return {
    on: (event, listener) => {
      client.on(event, listener);
    },
    off: (event, listener) => {
      client.off(event, listener);
    },
  };
}

export class DiscordGatewayAdapter {
  readonly #messageListener: DiscordGatewayListener;
  readonly #typingListener: DiscordGatewayListener;
  #started = false;

  constructor(
    private readonly client: DiscordGatewayEventClient,
    private readonly port: DiscordGatewayPort,
  ) {
    this.#messageListener = (message) => {
      this.dispatch("messageCreate", () => this.port.onMessage(toDiscordGatewayMessage(message)));
    };
    this.#typingListener = (typing) => {
      this.dispatch("typingStart", () => this.port.onTyping(toDiscordGatewayTyping(typing)));
    };
  }

  start(): void {
    if (this.#started) throw new Error("Discord Gateway adapter is already started");
    this.client.on("messageCreate", this.#messageListener);
    this.client.on("typingStart", this.#typingListener);
    this.#started = true;
  }

  stop(): void {
    if (!this.#started) throw new Error("Discord Gateway adapter is not started");
    this.client.off("messageCreate", this.#messageListener);
    this.client.off("typingStart", this.#typingListener);
    this.#started = false;
  }

  private dispatch(event: DiscordGatewayEvent, operation: () => Promise<void> | void): void {
    try {
      void Promise.resolve(operation()).catch((error: unknown) => {
        this.port.onError(error, event);
      });
    } catch (error: unknown) {
      this.port.onError(error, event);
    }
  }
}
