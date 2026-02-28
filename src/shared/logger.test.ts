import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeFileLogging, initializeFileLogging, logger } from "./logger";

describe("file logger", () => {
  const temporaryDirectories: string[] = [];
  const defaultReporters = [...logger.options.reporters];

  beforeEach(() => {
    logger.setReporters([]);
  });

  afterEach(async () => {
    await closeFileLogging();
    logger.setReporters(defaultReporters);
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directoryPath) => {
        await rm(directoryPath, {
          force: true,
          recursive: true,
        });
      }),
    );
  });

  it("logs ディレクトリに JSONL を出力する", async () => {
    const logsDir = await createTemporaryDirectory(temporaryDirectories);
    const fixedNow = new Date(2026, 1, 28, 9, 8, 7, 6);
    const { logFilePath } = await initializeFileLogging({
      logsDir,
      now: fixedNow,
    });

    expect(logFilePath).toBe(resolve(logsDir, "20260228-090807-006.log"));

    const marker = `file-logging-test-${Date.now()}`;
    logger.error(
      marker,
      {
        nested: {
          ok: true,
        },
      },
      new Error("boom"),
    );

    await closeFileLogging();

    const fileContent = await readFile(logFilePath, "utf8");
    const lines = fileContent
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);

    const entries = lines
      .map(parseJsonLine)
      .filter((entry): entry is Record<string, unknown> => entry !== undefined);
    const matchedEntry = entries.find((entry) => {
      const args = entry["args"];
      return Array.isArray(args) && args[0] === marker;
    });
    expect(matchedEntry).toBeDefined();
    if (!matchedEntry) {
      return;
    }

    expect(matchedEntry["type"]).toBe("error");
    const matchedArgs = matchedEntry["args"];
    expect(Array.isArray(matchedArgs)).toBe(true);
    if (!Array.isArray(matchedArgs)) {
      return;
    }
    expect(isRecord(matchedArgs[2])).toBe(true);
    if (!isRecord(matchedArgs[2])) {
      return;
    }
    expect(matchedArgs[2]["name"]).toBe("Error");
    expect(matchedArgs[2]["message"]).toBe("boom");
  });

  it("ログディレクトリが存在しない場合は初期化で失敗する", async () => {
    const logsDir = resolve(
      tmpdir(),
      `missing-logs-parent-${Date.now()}-${Math.random().toString(16)}`,
      "logs",
    );
    await expect(
      initializeFileLogging({
        logsDir,
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line);
    if (!isRecord(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function createTemporaryDirectory(targets: string[]): Promise<string> {
  const directoryPath = await mkdtemp(join(tmpdir(), "luna-logger-test-"));
  targets.push(directoryPath);
  return directoryPath;
}
