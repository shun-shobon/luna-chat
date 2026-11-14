import { describe, expect, it } from "vitest";

import { RecentLogBuffer } from "./recent-log-buffer";

describe("RecentLogBuffer", () => {
	it("context・詳細・本文を文字列にして保持する", () => {
		const buffer = createBuffer();

		buffer.record({
			level: "info",
			event: "conversation.message_accepted",
			context: { conversationSession: "discord:dm:1" },
			details: { messageId: "m1" },
			payload: { content: "こんにちは" },
		});
		buffer.record({
			level: "error",
			event: "conversation.operation_failed",
			context: {},
			details: { error: new Error("boom") },
		});

		expect(buffer.list()).toEqual([
			{
				seq: 1,
				timestamp: "2026-10-20T00:00:00.000Z",
				level: "info",
				event: "conversation.message_accepted",
				context: { conversationSession: "discord:dm:1" },
				details: '{"messageId":"m1"}',
				payload: '{"content":"こんにちは"}',
			},
			expect.objectContaining({
				seq: 2,
				event: "conversation.operation_failed",
				details: expect.stringContaining('"message":"boom"'),
				payload: null,
			}),
		]);
	});

	it("容量を超えたら古い順に捨てる", () => {
		const buffer = createBuffer({ capacity: 2 });

		for (const event of ["first", "second", "third"]) {
			buffer.record({ level: "info", event, context: {} });
		}

		expect(buffer.list().map((record) => [record.seq, record.event])).toEqual([
			[2, "second"],
			[3, "third"],
		]);
	});

	it("長い内容を切り詰め、秘匿フィールドをマスクする", () => {
		const buffer = createBuffer({ maxFieldLength: 20 });

		buffer.record({
			level: "info",
			event: "event",
			context: {},
			details: { authorization: "secret" },
			payload: { text: "x".repeat(100) },
		});

		const [record] = buffer.list();
		expect(record?.details).toBe('{"authorization":"[REDACTED]"}'.slice(0, 20) + "…(truncated)");
		expect(record?.payload).toBe(`{"text":"${"x".repeat(11)}…(truncated)`);
	});
});

function createBuffer(options: { capacity?: number; maxFieldLength?: number } = {}) {
	return new RecentLogBuffer({
		capacity: options.capacity ?? 10,
		maxFieldLength: options.maxFieldLength ?? 1_000,
		now: () => new Date("2026-10-20T00:00:00.000Z"),
	});
}
