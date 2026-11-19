import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ToolExecution } from "../../tool/domain/tool";
import type { ToolDefinition } from "../../tool/ports/tool-provider";
import { createVoiceToolProvider } from "./voice-tool-provider";

const execution: ToolExecution = {
	ownerId: "owner",
	origin: {
		kind: "conversation",
		session: { key: "discord:guild_channel:1:10", source: "discord/main", context: {} },
	},
	signal: new AbortController().signal,
};
const VC = { guildId: "1", channelId: "500", name: "雑談VC" };

function setup() {
	const voice = {
		join: vi.fn(async (input: { target: unknown; mode: "text" | "voice" }) => ({
			channel: VC,
			mode: input.mode,
		})),
		leave: vi.fn(async () => ({ channel: VC })),
		report: vi.fn(),
	};
	const tools = new Map<string, ToolDefinition>(
		createVoiceToolProvider(voice).definitions.map((definition) => [definition.name, definition]),
	);
	const tool = (name: string): ToolDefinition => {
		const definition = tools.get(name);
		if (definition === undefined) throw new Error(`missing tool ${name}`);
		return definition;
	};
	return { voice, tool };
}

describe("voice tools", () => {
	it("voice_join は呼んだ実行の文脈ごと渡し、入ったVCとモードを返す", async () => {
		const { voice, tool } = setup();

		await expect(
			tool("voice_join").invoke({ channel_id: "500", mode: "voice" }, execution),
		).resolves.toEqual({
			target: { channel_id: "500", mode: "voice" },
			value: { channel_id: "500", channel_name: "雑談VC", mode: "voice" },
		});
		expect(voice.join).toHaveBeenCalledWith(
			{ target: { channelId: "500" }, mode: "voice" },
			execution.origin,
		);
	});

	it("voice_join に user_id を渡すと、その人がいるVCを指定する", async () => {
		const { voice, tool } = setup();

		await expect(
			tool("voice_join").invoke({ user_id: "42", mode: "text" }, execution),
		).resolves.toMatchObject({ target: { user_id: "42", mode: "text" } });
		expect(voice.join).toHaveBeenCalledWith(
			{ target: { userId: "42" }, mode: "text" },
			execution.origin,
		);
	});

	it("voice_leave は出たVCを返す", async () => {
		const { tool } = setup();

		await expect(tool("voice_leave").invoke({}, execution)).resolves.toMatchObject({
			value: { channel_id: "500", channel_name: "雑談VC" },
		});
	});

	it("voice_report は前後の空白を除いて呼んだ実行の文脈ごと渡す", async () => {
		const { voice, tool } = setup();

		await expect(
			tool("voice_report").invoke({ text: " 明日は晴れだって " }, execution),
		).resolves.toEqual({
			target: { chars: 8 },
			value: { delivered: true },
		});
		expect(voice.report).toHaveBeenCalledWith("明日は晴れだって", execution.origin);
	});

	it.each<[string, unknown]>([
		["voice_join", { channel_id: "general", mode: "text" }],
		["voice_join", { channel_id: "500", mode: "video" }],
		["voice_join", { channel_id: "500" }],
		["voice_join", { mode: "text" }],
		["voice_join", { channel_id: "500", user_id: "42", mode: "text" }],
		["voice_leave", { channel_id: "500" }],
		["voice_report", { text: "  " }],
		["voice_report", { text: "あ".repeat(2001) }],
	])("%s の不正な入力 %j は失敗し、何もしない", async (name, input) => {
		const { voice, tool } = setup();

		await expect(tool(name).invoke(input, execution)).rejects.toBeInstanceOf(z.ZodError);
		expect(voice.join).not.toHaveBeenCalled();
		expect(voice.leave).not.toHaveBeenCalled();
		expect(voice.report).not.toHaveBeenCalled();
	});
});
