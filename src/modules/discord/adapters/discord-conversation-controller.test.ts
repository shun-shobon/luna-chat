import { describe, expect, it, vi } from "vitest";

import {
	DISCORD_EVENT_SOURCE,
	DISCORD_MESSAGE_CREATED_EVENT_TYPE,
	DISCORD_MESSAGE_DELETED_EVENT_TYPE,
	DISCORD_MESSAGE_EDITED_EVENT_TYPE,
	DISCORD_REACTION_ADDED_EVENT_TYPE,
	DISCORD_REACTION_REMOVED_EVENT_TYPE,
} from "../domain/discord-event";
import type { DiscordGatewayMessage } from "../ports/discord-gateway-port";
import { DiscordConversationController } from "./discord-conversation-controller";

describe("DiscordConversationController", () => {
	it("常設channelとmention開始sessionをConversationEventへ変換する", () => {
		const conversation = createConversation(false);
		const controller = createController(conversation);

		controller.onMessage(event("200", false));
		controller.onMessage(event("201", true));
		controller.onMessage(event("202", false));

		expect(conversation.accept).toHaveBeenCalledTimes(2);
		expect(conversation.accept).toHaveBeenNthCalledWith(1, {
			session: {
				key: "discord:guild_channel:300:200",
				source: DISCORD_EVENT_SOURCE,
				context: { kind: "guild_channel", guildId: "300", channelId: "200" },
			},
			event: expect.objectContaining({
				id: "400",
				type: DISCORD_MESSAGE_CREATED_EVENT_TYPE,
				source: DISCORD_EVENT_SOURCE,
				subject: "discord:guild_channel:300:200",
			}),
		});
		expect(conversation.hasSession).toHaveBeenCalledWith("discord:guild_channel:300:201");
	});

	it("Luna自身のmessageとbot typingを除外する", () => {
		const conversation = createConversation(true);
		const controller = createController(conversation);
		const own = event("200", false, "999");

		controller.onMessage(own);
		controller.onTyping({ scope: own.scope, userId: "100", isHuman: false });

		expect(conversation.accept).not.toHaveBeenCalled();
		expect(conversation.typing).not.toHaveBeenCalled();
	});

	it("Luna自身のmessageをそのスコープのセッションが知っているIDとして記憶させる", () => {
		const conversation = createConversation(true);
		const controller = createController(conversation);

		controller.onMessage(event("201", false, "999"));

		expect(conversation.remember).toHaveBeenCalledWith("discord:guild_channel:300:201", "400");
	});

	it("編集・削除・リアクションを対象messageのIDつきでセッションへ渡す", () => {
		const conversation = createConversation(true);
		const controller = createController(conversation);
		const edited = event("201", false);
		const reactionScope = edited.scope;
		const user = { id: "100", username: "shun", displayName: "Shun" };
		const emoji = { kind: "unicode", value: "🌙" } as const;

		controller.onMessageEdit({
			editedAt: "2026-07-23T00:05:00.000Z",
			message: edited.message,
			scope: edited.scope,
		});
		controller.onMessageDelete({ authorId: null, messageId: "401", scope: edited.scope });
		controller.onReaction({
			action: "added",
			emoji,
			messageId: "402",
			scope: reactionScope,
			user,
		});
		controller.onReaction({
			action: "removed",
			emoji,
			messageId: "402",
			scope: reactionScope,
			user,
		});

		const session = {
			key: "discord:guild_channel:300:201",
			source: DISCORD_EVENT_SOURCE,
			context: edited.scope,
		};
		const base = { id: "event-1", source: DISCORD_EVENT_SOURCE, subject: session.key };
		expect(conversation.acceptFollowUp.mock.calls).toEqual([
			[
				{
					session,
					event: {
						...base,
						type: DISCORD_MESSAGE_EDITED_EVENT_TYPE,
						occurredAt: "2026-07-23T00:05:00.000Z",
						data: { scope: edited.scope, message: edited.message },
					},
				},
				"400",
			],
			[
				{
					session,
					event: {
						...base,
						type: DISCORD_MESSAGE_DELETED_EVENT_TYPE,
						occurredAt: NOW.toISOString(),
						data: { scope: edited.scope, messageId: "401" },
					},
				},
				"401",
			],
			[
				{
					session,
					event: {
						...base,
						type: DISCORD_REACTION_ADDED_EVENT_TYPE,
						occurredAt: NOW.toISOString(),
						data: { scope: edited.scope, messageId: "402", emoji, user },
					},
				},
				"402",
			],
			[
				{
					session,
					event: {
						...base,
						type: DISCORD_REACTION_REMOVED_EVENT_TYPE,
						occurredAt: NOW.toISOString(),
						data: { scope: edited.scope, messageId: "402", emoji, user },
					},
				},
				"402",
			],
		]);
		expect(conversation.accept).not.toHaveBeenCalled();
	});

	it("Luna自身による編集・削除・リアクションは渡さない", () => {
		const conversation = createConversation(true);
		const controller = createController(conversation);
		const own = event("200", false, "999");

		controller.onMessageEdit({
			editedAt: "2026-07-23T00:05:00.000Z",
			message: own.message,
			scope: own.scope,
		});
		controller.onMessageDelete({ authorId: "999", messageId: "400", scope: own.scope });
		controller.onReaction({
			action: "added",
			emoji: { kind: "unicode", value: "🌙" },
			messageId: "400",
			scope: own.scope,
			user: { id: "999", username: "luna", displayName: null },
		});

		expect(conversation.acceptFollowUp).not.toHaveBeenCalled();
	});

	it("human typingをConversationSessionへ変換する", () => {
		const conversation = createConversation(false);
		const controller = createController(conversation);

		controller.onTyping({
			scope: { kind: "dm", channelId: "800", userId: "100" },
			userId: "100",
			isHuman: true,
		});

		expect(conversation.typing).toHaveBeenCalledWith(
			{
				key: "discord:dm:800:100",
				source: DISCORD_EVENT_SOURCE,
				context: { kind: "dm", channelId: "800", userId: "100" },
			},
			"100",
		);
	});

	it("許可channel配下のthreadはLuna参加中だけmentionなしで受理する", () => {
		const conversation = createConversation(false);
		const controller = createController(conversation);

		controller.onMessage(threadEvent(true));
		controller.onMessage(threadEvent(false));

		expect(conversation.accept).toHaveBeenCalledOnce();
	});

	it("VCに紐づいた会話のスコープは、常設でなくてもmentionなしで受理する", () => {
		const conversation = createConversation(false);
		const isVoiceBound = vi.fn(
			(sessionKey: string) => sessionKey === "discord:guild_channel:300:300",
		);
		const controller = createController(conversation, isVoiceBound);

		controller.onMessage(event("300", false));
		controller.onMessage(event("301", false));

		expect(conversation.accept).toHaveBeenCalledOnce();
	});

	it("共有された許可集合の更新を次の投稿から反映する", () => {
		const conversation = createConversation(false);
		const ids = new Set<string>();
		const controller = new DiscordConversationController(conversation, "999", {
			allowDm: true,
			allowedChannelIds: ids,
			createId: () => "event-1",
			now: () => NOW,
			isVoiceBound: () => false,
			onAccepted: vi.fn(),
			onError: vi.fn(),
		});

		controller.onMessage(event("200", false));
		expect(conversation.accept).not.toHaveBeenCalled();
		ids.add("200");
		controller.onMessage(event("200", false));
		expect(conversation.accept).toHaveBeenCalledOnce();
		ids.delete("200");
		controller.onMessage(event("200", false));
		expect(conversation.accept).toHaveBeenCalledOnce();
	});
});

const NOW = new Date("2026-07-23T00:10:00.000Z");

function createController(
	conversation: ReturnType<typeof createConversation>,
	isVoiceBound: (sessionKey: string) => boolean = () => false,
) {
	return new DiscordConversationController(conversation, "999", {
		allowDm: true,
		allowedChannelIds: new Set(["200"]),
		createId: () => "event-1",
		now: () => NOW,
		isVoiceBound,
		onAccepted: vi.fn(),
		onError: vi.fn(),
	});
}

function createConversation(sessionExists: boolean) {
	return {
		accept: vi.fn(),
		acceptFollowUp: vi.fn(),
		remember: vi.fn(),
		typing: vi.fn(),
		hasSession: vi.fn(() => sessionExists),
	};
}

function event(channelId: string, mention: boolean, authorId = "100"): DiscordGatewayMessage {
	return {
		lunaIsThreadMember: false,
		scope: { kind: "guild_channel", guildId: "300", channelId },
		message: {
			id: "400",
			timestamp: "2026-07-23T00:00:00.000Z",
			kind: "default",
			guild: { id: "300", name: "Luna Lab" },
			channel: { id: channelId, name: "general" },
			author: { id: authorId, kind: "human", username: "shun", displayName: "Shun" },
			content: "hello",
			attachments: [],
			stickers: [],
			reactions: [],
			mentions: {
				users: mention ? [{ id: "999", username: "luna", displayName: "Luna" }] : [],
				roles: [],
				channels: [],
				everyone: false,
			},
			replyTo: null,
		},
	};
}

function threadEvent(lunaIsThreadMember: boolean): DiscordGatewayMessage {
	const base = event("201", false);
	return {
		...base,
		lunaIsThreadMember,
		scope: { kind: "guild_thread", guildId: "300", parentChannelId: "200", threadId: "201" },
	};
}
