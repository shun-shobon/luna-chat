import { describe, expect, it, vi } from "vitest";

import { TypingLeaseRegistry } from "../application/typing-lease-registry";
import { DiscordActionAdapter } from "./discord-action-adapter";
import type {
	DiscordActionClient,
	MessageChannel,
	SendableChannel,
} from "./discord-action-adapter";

describe("DiscordActionAdapter", () => {
	it("DM channelを開いてmessageを送信する", async () => {
		const dm = createChannel();
		const client = createClient(createChannel(), dm);
		const adapter = createAdapter(client);

		await expect(
			adapter.execute(
				{ kind: "send_message", target: { kind: "dm_user", userId: "100" }, content: "hello" },
				"turn-1",
			),
		).resolves.toEqual({
			actionKind: "send_message",
			detail: { channelId: "200", messageId: "300" },
		});
		expect(client.users.createDM).toHaveBeenCalledWith("100");
		expect(client.channels.fetch).not.toHaveBeenCalled();
		expect(dm.send).toHaveBeenCalledWith({ content: "hello" });
	});

	it("reply失敗を通常投稿へ変換しない", async () => {
		const reply = vi.fn(async () => {
			throw new Error("unknown message");
		});
		const channel = createChannel({ reply });
		const adapter = createAdapter(createClient(channel));

		await expect(
			adapter.execute(
				{ kind: "reply_message", channelId: "200", messageId: "300", content: "hello" },
				"turn-1",
			),
		).rejects.toThrow("unknown message");
		expect(channel.send).not.toHaveBeenCalled();
	});

	it("ownerが開始したtypingだけを停止する", async () => {
		vi.useFakeTimers();
		const channel = createChannel();
		const adapter = createAdapter(createClient(channel), new TypingLeaseRegistry(1_000, vi.fn()));

		await adapter.execute(
			{ kind: "start_typing", target: { kind: "channel", channelId: "200" } },
			"turn-1",
		);
		await adapter.execute(
			{ kind: "stop_typing", target: { kind: "channel", channelId: "200" } },
			"turn-2",
		);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(channel.sendTyping).toHaveBeenCalledTimes(2);

		await adapter.releaseTyping("turn-1");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(channel.sendTyping).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	it("Luna自身のreactionを削除する", async () => {
		const remove = vi.fn(async () => undefined);
		const resolve = vi.fn((_emoji: string) => ({ users: { remove } }));
		const adapter = createAdapter(createClient(createChannel({ resolve })));

		await adapter.execute(
			{
				kind: "remove_reaction",
				channelId: "200",
				messageId: "300",
				emoji: { kind: "custom", id: "400", name: "luna" },
			},
			"turn-1",
		);

		expect(resolve).toHaveBeenCalledWith("luna:400");
		expect(remove).toHaveBeenCalledOnce();
	});
});

function createAdapter(
	client: DiscordActionClient,
	typing = new TypingLeaseRegistry(60_000, vi.fn()),
): DiscordActionAdapter {
	return new DiscordActionAdapter(client, async (file) => file, typing);
}

function createClient(
	channel: ReturnType<typeof createChannel>,
	dm: ReturnType<typeof createChannel> = createChannel(),
) {
	return {
		channels: { fetch: vi.fn(async (_channelId: string) => channel) },
		users: { createDM: vi.fn(async (_userId: string) => dm) },
	} satisfies DiscordActionClient;
}

function createChannel(
	overrides: {
		reply?: (options: unknown) => Promise<{ id: string }>;
		resolve?: (emoji: string) => { users: { remove(): Promise<unknown> } } | null;
	} = {},
) {
	const message = {
		reply: overrides.reply ?? vi.fn(async () => ({ id: "301" })),
		react: vi.fn(async () => undefined),
		reactions: { resolve: overrides.resolve ?? vi.fn(() => null) },
	};
	return {
		id: "200",
		send: vi.fn(async () => ({ id: "300" })),
		sendTyping: vi.fn(async () => undefined),
		messages: { fetch: vi.fn(async () => message) },
		isSendable(): this is SendableChannel {
			return true;
		},
		isTextBased(): this is MessageChannel {
			return true;
		},
	};
}
