import { describe, expect, it, vi } from "vitest";

import type { AcceptedConversationEvent } from "../../conversation/domain/conversation-session";
import type { AssistRequest } from "../domain/assist-request";
import { AssistResponseRegistry } from "./assist-response-registry";
import { AssistService } from "./assist-service";

describe("AssistService", () => {
	it("端末があれば端末ごとの会話へイベントを渡し、assist_respondの応答を返す", async () => {
		const { accepted, responses, service } = createService();

		const pending = service.submit(request({ device_id: "device-1" }));
		responses.respond("id-1", "つけたよ", false);

		await expect(pending).resolves.toEqual({
			kind: "response",
			speech: "つけたよ",
			continueConversation: false,
		});
		expect(accepted[0]).toEqual({
			session: {
				key: "home_assistant:assist:device:device-1",
				source: "home_assistant",
				context: { device_id: "device-1", device_name: "Voice PE", area_name: "リビング" },
			},
			event: {
				id: "id-1",
				type: "home_assistant.assist.requested.v1",
				source: "home_assistant",
				occurredAt: "2026-11-14T00:00:00.000Z",
				data: request({ device_id: "device-1" }),
			},
		});
	});

	it("端末がなければHAの会話IDごとの会話へ渡す", async () => {
		const { accepted, responses, service } = createService();

		const pending = service.submit(request({ device_id: null }));
		responses.complete("id-1", true);
		await pending;

		expect(accepted[0]?.session).toEqual({
			key: "home_assistant:assist:conversation:conv-1",
			source: "home_assistant",
			context: { conversation_id: "conv-1" },
		});
	});

	it("会話が受け付けなければunavailableを返し、応答待ちを残さない", async () => {
		const { responses, service } = createService({ accept: false });

		await expect(service.submit(request({}))).resolves.toEqual({ kind: "unavailable" });
		expect(() => responses.respond("id-1", "はい", false)).toThrow("not waiting");
	});

	it("stopIntakeの後は会話へ渡さずunavailableを返す", async () => {
		const { accept, service } = createService();

		service.stopIntake();

		await expect(service.submit(request({}))).resolves.toEqual({ kind: "unavailable" });
		expect(accept).not.toHaveBeenCalled();
	});
});

function createService(options: { accept?: boolean } = {}) {
	let nextId = 0;
	const accepted: AcceptedConversationEvent[] = [];
	const responses = new AssistResponseRegistry();
	const accept = vi.fn((input: AcceptedConversationEvent) => {
		accepted.push(input);
		return options.accept ?? true;
	});
	const service = new AssistService({
		conversation: { accept },
		createId: () => `id-${String(++nextId)}`,
		now: () => new Date("2026-11-14T00:00:00.000Z"),
		responses,
	});
	return { accept, accepted, responses, service };
}

function request(overrides: Partial<AssistRequest>): AssistRequest {
	return {
		text: "電気つけて",
		language: "ja",
		conversation_id: "conv-1",
		device_id: "device-1",
		satellite_id: "assist_satellite.voice_pe",
		device_name: "Voice PE",
		area_name: "リビング",
		user_name: "しゅん",
		...overrides,
	};
}
