import { createWriteStream, type WriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

import { createConsola, type ConsolaReporter, type LogObject } from "consola";

export const logger = createConsola();

type FileLoggingState = {
  reporter: ConsolaReporter;
  stream: WriteStream;
  logFilePath: string;
};

type FileLogEntry = {
  timestamp: string;
  level: number;
  type: string;
  tag: string;
  message: string | null;
  args: unknown[];
};

let fileLoggingState: FileLoggingState | undefined;

export async function initializeFileLogging(input: {
  logsDir: string;
  now?: Date;
}): Promise<{ logFilePath: string }> {
  if (fileLoggingState) {
    throw new Error("File logging is already initialized.");
  }

  const timestamp = formatLocalTimestampForFileName(input.now ?? new Date());
  const logFilePath = resolve(input.logsDir, `${timestamp}.log`);
  const handle = await open(logFilePath, "a");
  await handle.close();

  const stream = createWriteStream(logFilePath, {
    encoding: "utf8",
    flags: "a",
  });
  stream.on("error", (error: unknown) => {
    process.stderr.write(`[logger] Failed to write log file: ${toErrorMessage(error)}\n`);
  });

  const reporter: ConsolaReporter = {
    log: (logObj) => {
      try {
        const logEntry = toFileLogEntry(logObj);
        stream.write(`${JSON.stringify(logEntry)}\n`);
      } catch (error: unknown) {
        process.stderr.write(`[logger] Failed to serialize log entry: ${toErrorMessage(error)}\n`);
      }
    },
  };

  logger.addReporter(reporter);
  fileLoggingState = {
    logFilePath,
    reporter,
    stream,
  };

  return {
    logFilePath,
  };
}

export async function closeFileLogging(): Promise<void> {
  const currentState = fileLoggingState;
  if (!currentState) {
    return;
  }

  fileLoggingState = undefined;
  logger.removeReporter(currentState.reporter);
  await closeWriteStream(currentState.stream).catch((error: unknown) => {
    process.stderr.write(`[logger] Failed to close log file stream: ${toErrorMessage(error)}\n`);
  });
}

function toFileLogEntry(logObj: LogObject): FileLogEntry {
  const message =
    typeof logObj.args[0] === "string"
      ? logObj.args[0]
      : typeof logObj.message === "string"
        ? logObj.message
        : null;

  return {
    args: logObj.args.map((arg) => serializeLogArgument(arg)),
    level: Number(logObj.level),
    message,
    tag: logObj.tag,
    timestamp: logObj.date.toISOString(),
    type: logObj.type,
  };
}

function serializeLogArgument(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value instanceof Error) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return serializeError(value, seen);
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeLogArgument(item, seen));
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function") {
    return `[Function:${value.name || "anonymous"}]`;
  }

  if (!isRecord(value)) {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  const serialized: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    serialized[key] = serializeLogArgument(entryValue, seen);
  }

  return serialized;
}

function serializeError(error: Error, seen: WeakSet<object>): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    message: error.message,
    name: error.name,
  };

  if (typeof error.stack === "string") {
    serialized["stack"] = error.stack;
  }
  if ("cause" in error) {
    serialized["cause"] = serializeLogArgument(error.cause, seen);
  }
  for (const [key, value] of Object.entries(error)) {
    if (key === "message" || key === "name" || key === "stack" || key === "cause") {
      continue;
    }
    serialized[key] = serializeLogArgument(value, seen);
  }

  return serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatLocalTimestampForFileName(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");

  return `${year}${month}${day}-${hours}${minutes}${seconds}-${milliseconds}`;
}

async function closeWriteStream(stream: WriteStream): Promise<void> {
  if (stream.destroyed) {
    return;
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const handleError = (error: Error) => {
      stream.off("error", handleError);
      rejectPromise(error);
    };

    stream.once("error", handleError);
    stream.end(() => {
      stream.off("error", handleError);
      resolvePromise();
    });
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}
