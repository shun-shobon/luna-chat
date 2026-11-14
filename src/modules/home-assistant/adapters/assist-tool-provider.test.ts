import { describe, expect, it, vi } from "vitest";

import { createRecordingLogger } from "../../observability/testing/recording-logger";
import { createToolSet } from "../../tool/application/tool-set";
import { createAssistToolProvider } from "./assist-tool-provider";

const REQUEST_ID = "4f9d2c3a-1b2e-4c5d-8e9f-0a1b2c3d4e5f";

describe("createAssistToolProvider", () => {
	it("前後の空白を除いた読み上げ文で応答し、continue_conversationの省略はfalseにする", async () => {
		const { respond, run } = createHarness();

		const result = await run({ request_id: REQUEST_ID, speech: "  消したよ \n" });

		expect(respond).toHaveBeenCalledWith(REQUEST_ID, "消したよ", false);
		expect(JSON.parse(result.text)).toEqual({ request_id: REQUEST_ID });
	});

	it("continue_conversationを渡す", async () => {
		const { respond, run } = createHarness();

		await run({ request_id: REQUEST_ID, speech: "どの部屋？", continue_conversation: true });

		expect(respond).toHaveBeenCalledWith(REQUEST_ID, "どの部屋？", true);
	});

	it.each([
		["UUIDでないrequest_id", { request_id: "request-1", speech: "はい" }],
		["空白だけのspeech", { request_id: REQUEST_ID, speech: "   " }],
		["2000文字を超えるspeech", { request_id: REQUEST_ID, speech: "あ".repeat(2_001) }],
	])("%sは検証エラーにして応答しない", async (_label, input) => {
		const { respond, run } = createHarness();

		const result = await run(input);

		expect(result.isError).toBe(true);
		expect(respond).not.toHaveBeenCalled();
	});

	it("応答待ちでないリクエストへの応答はツールの失敗にする", async () => {
		const { run } = createHarness(() => {
			throw new Error(`Assist request is not waiting for a response: ${REQUEST_ID}.`);
		});

		const result = await run({ request_id: REQUEST_ID, speech: "はい" });

		expect(result).toMatchObject({
			isError: true,
			text: `Assist request is not waiting for a response: ${REQUEST_ID}.`,
		});
	});
});

function createHarness(
	implementation: (
		requestId: string,
		speech: string,
		continueConversation: boolean,
	) => void = () => {},
) {
	const respond = vi.fn(implementation);
	const [tool] = createToolSet(
		[createAssistToolProvider({ respond })],
		createRecordingLogger(),
	).bind({ ownerId: "owner-1", origin: { kind: "event", eventId: "e", eventType: "t" } });
	return {
		respond,
		run: async (input: unknown) => {
			if (tool === undefined) throw new Error("assist_respond is missing");
			return await tool.execute(input, new AbortController().signal);
		},
	};
}
