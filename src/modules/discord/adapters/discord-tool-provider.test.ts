import { describe, expect, it, vi } from "vitest";

import type { JsonValue } from "../../../shared/json";
import type { AgentTool } from "../../agent/ports/outbound/agent-session-port";
import { createRecordingLogger } from "../../observability/testing/recording-logger";
import { createToolSet } from "../../tool/application/tool-set";
import type { ToolProvider } from "../../tool/ports/tool-provider";
import type { DiscordActionPort } from "../ports/discord-action-port";
import type { DiscordConversationDelegationPort } from "../ports/discord-conversation-delegation-port";
import type { DiscordReadPort } from "../ports/discord-read-port";
import { createDiscordReadToolProvider, createDiscordToolProvider } from "./discord-tool-provider";

const READ_TOOLS = [
	"read_message_history",
	"list_channels",
	"get_user_detail",
	"list_guild_emojis",
	"get_guild_emoji",
];
const WRITE_TOOLS = [
	"send_message",
	"reply_message",
	"add_reaction",
	"remove_reaction",
	"start_typing",
	"stop_typing",
];

describe("Discord tool provider", () => {
	it("読み取り・書き込み・会話委譲のツールを公開する", () => {
		const provider = createProvider();

		expect(provider.definitions.map((definition) => definition.name)).toEqual([
			...READ_TOOLS,
			...WRITE_TOOLS,
			"open_conversation",
		]);
	});

	it("読み取り専用プロバイダーには書き込みと会話委譲のツールがない", async () => {
		const read = createReadPort();
		const provider = createDiscordReadToolProvider(read);

		expect(provider.definitions.map((definition) => definition.name)).toEqual(READ_TOOLS);
		await expect(provider.release("owner-1")).resolves.toBeUndefined();
	});

	it("読み取りツールを対応するportへそのまま委譲する", async () => {
		const read = createReadPort();
		const tools = bind(createProvider({ read }));

		await call(tools, "read_message_history", {
			channelId: "300",
			limit: 10,
			beforeMessageId: "100",
		});
		await call(tools, "list_channels", {});
		await call(tools, "get_user_detail", { userId: "400", guildId: "200" });
		await call(tools, "list_guild_emojis", { guildId: "200" });
		const emoji = await call(tools, "get_guild_emoji", { guildId: "200", emojiId: "500" });

		expect(read.readMessageHistory).toHaveBeenCalledWith({
			channelId: "300",
			limit: 10,
			beforeMessageId: "100",
		});
		expect(read.listChannels).toHaveBeenCalledOnce();
		expect(read.getUserDetail).toHaveBeenCalledWith({ userId: "400", guildId: "200" });
		expect(read.listGuildEmojis).toHaveBeenCalledWith("200");
		expect(read.getGuildEmoji).toHaveBeenCalledWith({ guildId: "200", emojiId: "500" });
		expect(JSON.parse(emoji.text)).toMatchObject({ id: "500", name: "luna" });
	});

	it("書き込みツールをDiscordActionへ変換し、実行元のownerIdで即時実行する", async () => {
		const actions = createActionPort();
		const tools = bind(createProvider({ actions }));
		const cases: readonly Readonly<{ name: string; input: JsonValue; action: JsonValue }>[] = [
			{
				name: "send_message",
				input: { target: { kind: "dm_user", userId: "100" }, content: "hello" },
				action: {
					kind: "send_message",
					target: { kind: "dm_user", userId: "100" },
					content: "hello",
				},
			},
			{
				name: "reply_message",
				input: {
					channelId: "200",
					messageId: "300",
					files: [{ path: "/tmp/result.txt", description: "result" }],
				},
				action: {
					kind: "reply_message",
					channelId: "200",
					messageId: "300",
					files: [{ path: "/tmp/result.txt", description: "result" }],
				},
			},
			{
				name: "add_reaction",
				input: { channelId: "200", messageId: "300", emoji: { kind: "unicode", value: "🌙" } },
				action: {
					kind: "add_reaction",
					channelId: "200",
					messageId: "300",
					emoji: { kind: "unicode", value: "🌙" },
				},
			},
			{
				name: "remove_reaction",
				input: { channelId: "200", messageId: "300", emoji: { kind: "custom", id: "400" } },
				action: {
					kind: "remove_reaction",
					channelId: "200",
					messageId: "300",
					emoji: { kind: "custom", id: "400" },
				},
			},
			{
				name: "start_typing",
				input: { target: { kind: "channel", channelId: "200" } },
				action: { kind: "start_typing", target: { kind: "channel", channelId: "200" } },
			},
			{
				name: "stop_typing",
				input: { target: { kind: "channel", channelId: "200" } },
				action: { kind: "stop_typing", target: { kind: "channel", channelId: "200" } },
			},
		];

		for (const testCase of cases) {
			const result = await call(tools, testCase.name, testCase.input);
			expect(JSON.parse(result.text)).toEqual({ actionKind: testCase.name, detail: {} });
		}

		expect(actions.execute.mock.calls).toEqual(cases.map(({ action }) => [action, "owner-1"]));
	});

	it.each([
		[
			"未知のfield",
			"send_message",
			{ target: { kind: "channel", channelId: "300" }, content: "hi", unexpected: true },
		],
		[
			"本文もファイルもないmessage",
			"send_message",
			{ target: { kind: "channel", channelId: "300" } },
		],
		[
			"相対パスのファイル",
			"reply_message",
			{ channelId: "300", messageId: "100", files: [{ path: "relative.txt" }] },
		],
		[
			"2000文字を超える本文",
			"send_message",
			{ target: { kind: "channel", channelId: "300" }, content: "x".repeat(2_001) },
		],
		[
			"snowflakeでないchannelId",
			"start_typing",
			{ target: { kind: "channel", channelId: "general" } },
		],
	])("%sをport実行前に拒否する", async (_label, name, input) => {
		const actions = createActionPort();
		const tools = bind(createProvider({ actions }));

		await expect(
			tool(tools, name).execute(input, new AbortController().signal),
		).resolves.toMatchObject({
			isError: true,
		});
		expect(actions.execute).not.toHaveBeenCalled();
	});

	it.each([
		[
			"複数のcursor",
			{ channelId: "300", limit: 10, beforeMessageId: "100", afterMessageId: "101" },
		],
		["上限を超えるlimit", { channelId: "300", limit: 101 }],
		["0件のlimit", { channelId: "300", limit: 0 }],
	])("%sのhistory要求をport実行前に拒否する", async (_label, input) => {
		const read = createReadPort();
		const tools = bind(createProvider({ read }));

		const result = await tool(tools, "read_message_history").execute(
			input,
			new AbortController().signal,
		);

		expect(result.isError).toBe(true);
		expect(read.readMessageHistory).not.toHaveBeenCalled();
	});

	it("portの失敗をisErrorとしてモデルへ返す", async () => {
		const actions = createActionPort();
		actions.execute.mockRejectedValueOnce(new Error("Missing Permissions"));
		const tools = bind(createProvider({ actions }));

		await expect(
			tool(tools, "send_message").execute(
				{ target: { kind: "channel", channelId: "300" }, content: "hi" },
				new AbortController().signal,
			),
		).resolves.toMatchObject({ text: "Missing Permissions", isError: true });
	});

	it("open_conversationをtargetとbriefで委譲し、解決したscopeを返す", async () => {
		const scope = { kind: "dm", channelId: "500", userId: "100" } as const;
		const delegation = {
			delegate: vi.fn<DiscordConversationDelegationPort["delegate"]>(async () => scope),
		};
		const tools = bind(createProvider({ delegation }));

		const result = await call(tools, "open_conversation", {
			target: { kind: "dm_user", userId: "100" },
			brief: "帰宅したので夕飯の相談をしたい",
		});

		expect(JSON.parse(result.text)).toEqual({ scope });
		expect(delegation.delegate).toHaveBeenCalledWith(
			{ kind: "dm_user", userId: "100" },
			"帰宅したので夕飯の相談をしたい",
		);
	});

	it.each([
		["空のbrief", { target: { kind: "channel", channelId: "200" }, brief: "  " }],
		["未知のfield", { target: { kind: "channel", channelId: "200" }, brief: "x", content: "hi" }],
	])("open_conversationの%sを拒否する", async (_label, input) => {
		const delegation = { delegate: vi.fn<DiscordConversationDelegationPort["delegate"]>() };
		const tools = bind(createProvider({ delegation }));

		await expect(
			tool(tools, "open_conversation").execute(input, new AbortController().signal),
		).resolves.toMatchObject({ isError: true });
		expect(delegation.delegate).not.toHaveBeenCalled();
	});

	it("releaseで実行元のtypingを解放する", async () => {
		const actions = createActionPort();

		await createProvider({ actions }).release("owner-1");

		expect(actions.releaseTyping).toHaveBeenCalledWith("owner-1");
	});
});

function createProvider(
	overrides: Partial<{
		actions: DiscordActionPort;
		delegation: DiscordConversationDelegationPort;
		read: DiscordReadPort;
	}> = {},
): ToolProvider {
	return createDiscordToolProvider({
		actions: overrides.actions ?? createActionPort(),
		delegation: overrides.delegation ?? { delegate: vi.fn() },
		read: overrides.read ?? createReadPort(),
	});
}

function bind(provider: ToolProvider): readonly AgentTool[] {
	return createToolSet([provider], createRecordingLogger()).bind({
		ownerId: "owner-1",
		origin: { kind: "event", eventId: "event-1", eventType: "test.v1" },
	});
}

function tool(tools: readonly AgentTool[], name: string): AgentTool {
	const found = tools.find((candidate) => candidate.name === name);
	if (found === undefined) throw new Error(`Missing tool ${name}`);
	return found;
}

async function call(tools: readonly AgentTool[], name: string, input: JsonValue) {
	const result = await tool(tools, name).execute(input, new AbortController().signal);
	if (result.isError) throw new Error(`${name} failed: ${result.text}`);
	return result;
}

function createActionPort() {
	return {
		execute: vi.fn<DiscordActionPort["execute"]>(async (action) => ({
			actionKind: action.kind,
			detail: {},
		})),
		releaseTyping: vi.fn<DiscordActionPort["releaseTyping"]>(async () => undefined),
	};
}

function createReadPort() {
	return {
		readMessageHistory: vi.fn<DiscordReadPort["readMessageHistory"]>(async () => []),
		listChannels: vi.fn<DiscordReadPort["listChannels"]>(async () => []),
		getUserDetail: vi.fn<DiscordReadPort["getUserDetail"]>(async ({ userId }) => ({
			id: userId,
			username: "shun",
			globalName: null,
			bot: false,
			system: false,
			avatarUrl: null,
			bannerUrl: null,
		})),
		listGuildEmojis: vi.fn<DiscordReadPort["listGuildEmojis"]>(async () => []),
		getGuildEmoji: vi.fn<DiscordReadPort["getGuildEmoji"]>(async ({ guildId, emojiId }) => ({
			id: emojiId,
			guildId,
			name: "luna",
			animated: false,
			available: true,
			mention: `<:luna:${emojiId}>`,
			url: `https://cdn.discordapp.com/emojis/${emojiId}.webp`,
		})),
	};
}
