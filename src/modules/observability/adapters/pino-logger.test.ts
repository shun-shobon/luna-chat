import { describe, expect, it } from "vitest";

import type { LogEntry, LogLevel } from "../ports/logger-port";
import { createPinoLogger } from "./pino-logger";

function createLogger(level: LogLevel) {
	const lines: string[] = [];
	const entries: LogEntry[] = [];
	const logger = createPinoLogger({
		level,
		onEntry: (entry) => entries.push(entry),
		destination: { write: (line: string) => lines.push(line) },
		now: () => new Date("2026-07-23T00:00:00.000Z"),
	});
	const records = () => lines.map((line): unknown => JSON.parse(line));
	return { logger, records, entries };
}

describe("createPinoLogger", () => {
	it("childで束ねたcontextと詳細を1行のJSONで書き出す", () => {
		const { logger, records } = createLogger("info");

		logger.child({ taskId: "task-1" }).child({ jobId: "job-1" }).info("task.started", { n: 1 });

		expect(records()).toEqual([
			{
				timestamp: "2026-07-23T00:00:00.000Z",
				level: "info",
				taskId: "task-1",
				jobId: "job-1",
				details: { n: 1 },
				event: "task.started",
			},
		]);
	});

	it("LOG_LEVEL未満は標準出力に書かないが、直近ログへは渡す", () => {
		const { logger, records, entries } = createLogger("error");

		logger.child({ eventId: "e1" }).info("event.execution_started", { subject: "s" }, { body: 1 });

		expect(records()).toEqual([]);
		expect(entries).toEqual([
			{
				level: "info",
				event: "event.execution_started",
				context: { eventId: "e1" },
				details: { subject: "s" },
				payload: { body: 1 },
			},
		]);
	});

	it("payloadはdebug以下のLOG_LEVELだけで書き出し、秘匿キーを深さと大文字小文字を問わず伏せる", () => {
		const info = createLogger("info");
		const debug = createLogger("debug");
		const payload = { DISCORD_BOT_TOKEN: "secret", headers: { Authorization: "Bearer secret" } };

		info.logger.info("request", undefined, payload);
		debug.logger.info("request", undefined, payload);

		expect(info.records()[0]).not.toHaveProperty("payload");
		expect(debug.records()[0]).toMatchObject({
			payload: { DISCORD_BOT_TOKEN: "[REDACTED]", headers: { Authorization: "[REDACTED]" } },
		});
	});

	it("Errorの原因と循環参照を直列化する", () => {
		const { logger, records } = createLogger("info");
		const details: { error: Error; self?: unknown } = {
			error: new Error("boom", { cause: new Error("root") }),
		};
		details.self = details;

		logger.error("failed", details);

		expect(records()[0]).toMatchObject({
			level: "error",
			details: {
				error: { name: "Error", message: "boom", cause: { message: "root" } },
				self: "[Circular]",
			},
		});
	});
});
