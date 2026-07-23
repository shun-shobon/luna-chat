import type { LoggerPort, LogContext, LogLevel } from "../ports/logger-port";

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

const REDACTED = "[REDACTED]";
const SECRET_FIELDS = new Set(["authorization", "discord_bot_token", "discordbottoken"]);

export class JsonLinesLogger implements LoggerPort {
  constructor(
    private readonly minimumLevel: LogLevel,
    private readonly write: (line: string) => void = (line) => process.stdout.write(line),
    private readonly now: () => Date = () => new Date(),
    private readonly flushOutput: () => Promise<void> = async () =>
      await new Promise<void>((resolve, reject) => {
        process.stdout.write("", (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  ) {}

  async flush(): Promise<void> {
    await this.flushOutput();
  }

  log(
    level: LogLevel,
    event: string,
    context: LogContext = {},
    details?: Readonly<Record<string, unknown>>,
    payload?: unknown,
  ): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minimumLevel]) return;
    const includePayload = LEVEL_PRIORITY[this.minimumLevel] <= LEVEL_PRIORITY.debug;
    const record = {
      timestamp: this.now().toISOString(),
      level,
      event,
      ...context,
      ...(details === undefined ? {} : { details: serialize(details, new WeakSet()) }),
      ...(includePayload && payload !== undefined
        ? { payload: serialize(payload, new WeakSet()) }
        : {}),
    };
    this.write(`${JSON.stringify(record)}\n`);
  }
}

function serialize(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack === undefined ? {} : { stack: value.stack }),
      ...(value.cause === undefined ? {} : { cause: serialize(value.cause, seen) }),
    };
  }
  if (Array.isArray(value)) return value.map((item) => serialize(item, seen));
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SECRET_FIELDS.has(key.toLowerCase()) ? REDACTED : serialize(child, seen);
  }
  return output;
}
