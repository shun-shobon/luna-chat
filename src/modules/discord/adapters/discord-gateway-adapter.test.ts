import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { DiscordGatewayEventName, DiscordGatewayPort } from "../ports/discord-gateway-port";
import { DiscordGatewayAdapter } from "./discord-gateway-adapter";
import type { DiscordGatewayEventClient } from "./discord-gateway-adapter";

describe("DiscordGatewayAdapter", () => {
	it("messageCreateとtypingStartを正規化済みeventとしてportへ渡す", async () => {
		const client = new FakeGatewayClient();
		const port = createPort();
		const { onMessage, onTyping } = port;
		const adapter = new DiscordGatewayAdapter(client, port);

		adapter.start();
		client.emit("messageCreate", createMessage());
		client.emit("typingStart", {
			channel: createChannel(),
			guild: { id: "200" },
			user: createUser({ id: "401" }),
		});
		expect(onMessage).toHaveBeenCalledOnce();
		expect(onTyping).toHaveBeenCalledOnce();

		expect(onMessage.mock.calls[0]?.[0].scope).toEqual({
			kind: "guild_channel",
			guildId: "200",
			channelId: "300",
		});
		expect(onTyping.mock.calls[0]?.[0]).toEqual({
			scope: { kind: "guild_channel", guildId: "200", channelId: "300" },
			userId: "401",
			isHuman: true,
		});
		adapter.stop();
		expect(client.listenerCount()).toBe(0);
	});

	it("変換失敗とport失敗を明示的にonErrorへ渡す", () => {
		const client = new FakeGatewayClient();
		const port = createPort();
		port.onMessage.mockImplementation(() => {
			throw new Error("port failed");
		});
		const { onError } = port;
		const adapter = new DiscordGatewayAdapter(client, port);
		adapter.start();

		client.emit("messageCreate", createMessage());
		client.emit("messageUpdate", {}, {});
		client.emit("messageDelete", {});
		client.emit("messageReactionAdd", {}, createUser());
		client.emit("messageReactionRemove", {}, createUser());
		client.emit("typingStart", {});
		expect(onError.mock.calls.map((call) => call[1])).toEqual([
			"messageCreate",
			"messageUpdate",
			"messageDelete",
			"messageReactionAdd",
			"messageReactionRemove",
			"typingStart",
		]);
	});

	it("編集時刻が変わったmessageUpdateだけを編集として渡す", () => {
		const client = new FakeGatewayClient();
		const port = createPort();
		new DiscordGatewayAdapter(client, port).start();
		const editedAt = Date.parse("2026-07-23T01:05:00.000Z");

		client.emit(
			"messageUpdate",
			{ editedTimestamp: null },
			createMessage({ editedTimestamp: null }),
		);
		client.emit(
			"messageUpdate",
			{ editedTimestamp: editedAt },
			createMessage({ editedTimestamp: editedAt }),
		);
		client.emit(
			"messageUpdate",
			{ editedTimestamp: null },
			createMessage({ content: "fixed", editedTimestamp: editedAt }),
		);

		expect(port.onMessageEdit).toHaveBeenCalledOnce();
		expect(port.onMessageEdit).toHaveBeenCalledWith({
			editedAt: "2026-07-23T01:05:00.000Z",
			message: expect.objectContaining({ id: "100", content: "fixed" }),
			scope: { kind: "guild_channel", guildId: "200", channelId: "300" },
		});
	});

	it("キャッシュにないmessageの削除は投稿者を不明として渡す", () => {
		const client = new FakeGatewayClient();
		const port = createPort();
		new DiscordGatewayAdapter(client, port).start();

		client.emit("messageDelete", {
			id: "100",
			guildId: "200",
			channel: createChannel(),
			author: null,
		});
		client.emit("messageDelete", createMessage());

		expect(port.onMessageDelete.mock.calls).toEqual([
			[
				{
					authorId: null,
					messageId: "100",
					scope: { kind: "guild_channel", guildId: "200", channelId: "300" },
				},
			],
			[
				{
					authorId: "400",
					messageId: "100",
					scope: { kind: "guild_channel", guildId: "200", channelId: "300" },
				},
			],
		]);
	});

	it.each([
		["messageReactionAdd", "added"],
		["messageReactionRemove", "removed"],
	] as const)("%sを%sのリアクションとして渡す", (event, action) => {
		const client = new FakeGatewayClient();
		const port = createPort();
		new DiscordGatewayAdapter(client, port).start();

		client.emit(
			event,
			{
				emoji: { id: "500", name: "luna", animated: false },
				message: { id: "100", guildId: "200", channel: createChannel() },
			},
			createUser({ id: "401" }),
		);

		expect(port.onReaction).toHaveBeenCalledWith({
			action,
			emoji: { kind: "custom", id: "500", name: "luna", animated: false },
			messageId: "100",
			scope: { kind: "guild_channel", guildId: "200", channelId: "300" },
			user: { id: "401", username: "shun", displayName: "Shun" },
		});
	});
});

function createPort() {
	return {
		onMessage: vi.fn<DiscordGatewayPort["onMessage"]>(),
		onMessageEdit: vi.fn<DiscordGatewayPort["onMessageEdit"]>(),
		onMessageDelete: vi.fn<DiscordGatewayPort["onMessageDelete"]>(),
		onReaction: vi.fn<DiscordGatewayPort["onReaction"]>(),
		onTyping: vi.fn<DiscordGatewayPort["onTyping"]>(),
		onError: vi.fn<DiscordGatewayPort["onError"]>(),
	};
}

type Listener = (...payload: unknown[]) => void;

class FakeGatewayClient implements DiscordGatewayEventClient {
	readonly listeners = new Map<string, Set<Listener>>();

	on(event: DiscordGatewayEventName, listener: Listener): void {
		const listeners = this.listeners.get(event) ?? new Set();
		listeners.add(listener);
		this.listeners.set(event, listeners);
	}

	off(event: DiscordGatewayEventName, listener: Listener): void {
		this.listeners.get(event)?.delete(listener);
	}

	emit(event: DiscordGatewayEventName, ...payload: unknown[]): void {
		for (const listener of this.listeners.get(event) ?? []) listener(...payload);
	}

	listenerCount(): number {
		return Array.from(this.listeners.values()).reduce(
			(count, listeners) => count + listeners.size,
			0,
		);
	}
}

function createMessage(overrides: Readonly<Record<string, unknown>> = {}) {
	return {
		id: "100",
		createdAt: new Date("2026-07-23T01:00:00.000Z"),
		system: false,
		guild: { id: "200", name: "Luna Lab" },
		guildId: "200",
		channel: createChannel(),
		author: createUser(),
		member: { displayName: "Shun" },
		webhookId: null,
		content: "hello",
		attachments: new Map(),
		stickers: new Map(),
		reactions: { cache: new Map() },
		mentions: {
			users: new Map(),
			roles: new Map(),
			channels: new Map(),
			everyone: false,
		},
		reference: null,
		...overrides,
	};
}

function createChannel() {
	return {
		id: "300",
		type: ChannelType.GuildText,
		name: "general",
		parentId: null,
		recipient: null,
	};
}

function createUser(overrides: Readonly<Record<string, unknown>> = {}) {
	return {
		id: "400",
		username: "shun",
		globalName: "Shun",
		bot: false,
		system: false,
		...overrides,
	};
}
