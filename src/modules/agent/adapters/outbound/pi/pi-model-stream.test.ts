import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type { ModelStreamEvent, ModelStreamSpec } from "../../../ports/outbound/model-stream-port";
import { PiModelStreams } from "./pi-model-stream";

const SPEC: ModelStreamSpec = {
	model: { provider: "faux", model: "faux-1", thinking: "off" },
	systemPrompt: "voice",
	tools: [
		{
			name: "delegate",
			description: "Hand off",
			parameters: { type: "object", properties: { request: { type: "string" } } },
		},
	],
};

function setup() {
	const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux One" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, streams: new PiModelStreams({ models, requestTimeoutMs: 5000 }) };
}

async function collect(events: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
	const collected: ModelStreamEvent[] = [];
	for await (const event of events) collected.push(event);
	return collected;
}

describe("PiModelStreams", () => {
	it("システムプロンプト・ツール・1つの user 文で要求し、本文の差分とツール呼び出しを流す", async () => {
		const { faux, streams } = setup();
		const contexts: TranscriptContext[] = [];
		faux.setResponses([
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage([
					fauxText("ちょっと調べるね。"),
					fauxToolCall("delegate", { request: "天気" }),
				]);
			},
		]);
		const stream = streams.open(SPEC);

		const events = await collect(stream.stream("記録", new AbortController().signal));

		expect(
			events
				.filter((event) => event.type === "text")
				.map((event) => event.delta)
				.join(""),
		).toBe("ちょっと調べるね。");
		expect(events.at(-1)).toEqual({
			type: "tool_call",
			name: "delegate",
			arguments: { request: "天気" },
		});
		expect(JSON.stringify(contexts[0])).toContain("記録");
		expect(JSON.stringify(contexts[0])).toContain("delegate");
		await stream.close();
	});

	it("モデルの失敗は例外で終わる", async () => {
		const { faux, streams } = setup();
		faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom" })]);

		await expect(
			collect(streams.open(SPEC).stream("記録", new AbortController().signal)),
		).rejects.toThrow("boom");
	});

	it("中断したら中断の理由で終わる", async () => {
		const { faux, streams } = setup();
		faux.setResponses([fauxAssistantMessage([fauxText("長い返事")])]);
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));

		await expect(collect(streams.open(SPEC).stream("記録", controller.signal))).rejects.toThrow(
			"cancelled",
		);
	});

	it("カタログにないモデルは開く時に失敗する", () => {
		const { streams } = setup();

		expect(() =>
			streams.open({ ...SPEC, model: { provider: "faux", model: "missing", thinking: "off" } }),
		).toThrow("Unknown model: faux/missing");
	});
});
