import { describe, expect, it, vi } from "vitest";

import { JsonLinesLogger } from "./json-lines-logger";

describe("JsonLinesLogger", () => {
  it("一行JSONへcorrelation contextを書き出す", () => {
    const write = vi.fn();
    const logger = new JsonLinesLogger("info", write, () => new Date("2026-07-23T00:00:00.000Z"));

    logger.log("info", "turn.completed", { threadId: "thread-1", turnId: "turn-1" });

    expect(write).toHaveBeenCalledWith(
      '{"timestamp":"2026-07-23T00:00:00.000Z","level":"info","event":"turn.completed","threadId":"thread-1","turnId":"turn-1"}\n',
    );
  });

  it("payloadはdebug以上の詳細levelだけに含め、既知secret fieldを再帰的に伏せる", () => {
    const lines: string[] = [];
    const infoLogger = new JsonLinesLogger("info", (line) => lines.push(line));
    const debugLogger = new JsonLinesLogger("debug", (line) => lines.push(line));
    const payload = { DISCORD_BOT_TOKEN: "secret", headers: { authorization: "Bearer secret" } };

    infoLogger.log("info", "request", {}, undefined, payload);
    debugLogger.log("info", "request", {}, undefined, payload);

    expect(JSON.parse(lines[0] ?? "null")).not.toHaveProperty("payload");
    expect(JSON.parse(lines[1] ?? "null")).toMatchObject({
      payload: {
        DISCORD_BOT_TOKEN: "[REDACTED]",
        headers: { authorization: "[REDACTED]" },
      },
    });
  });

  it("flushをoutput境界へ委譲する", async () => {
    const flush = vi.fn(async () => undefined);
    const logger = new JsonLinesLogger("info", vi.fn(), () => new Date(), flush);

    await logger.flush();

    expect(flush).toHaveBeenCalledOnce();
  });

  it("Errorと循環参照を直列化する", () => {
    const write = vi.fn();
    const logger = new JsonLinesLogger("debug", write);
    const payload: { error: Error; self?: unknown } = { error: new Error("boom") };
    payload.self = payload;

    expect(() => logger.log("debug", "failed", {}, undefined, payload)).not.toThrow();
    expect(JSON.parse(write.mock.calls[0]?.[0] ?? "null")).toMatchObject({
      payload: { error: { name: "Error", message: "boom" }, self: "[Circular]" },
    });
  });
});
