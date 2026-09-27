import { z } from "zod";

import type { LogLevel } from "../modules/observability/ports/logger-port";

const RuntimeEnvironmentSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().refine((value) => value.trim().length > 0, "must not be blank"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  LUNA_HTTP_HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
  LUNA_HTTP_PORT: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535))
    .default(3000),
  LUNA_HOME: z.string().optional(),
});

type RuntimeEnvironment = Readonly<{
  discordBotToken: string;
  httpHost: "127.0.0.1" | "0.0.0.0";
  httpPort: number;
  logLevel: LogLevel;
  lunaHome?: string | undefined;
}>;

class RuntimeEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeEnvironmentError";
  }
}

export function readRuntimeEnvironment(environment: NodeJS.ProcessEnv): RuntimeEnvironment {
  const result = RuntimeEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    throw new RuntimeEnvironmentError(
      `runtime environment is invalid: ${z.prettifyError(result.error)}`,
    );
  }
  return {
    discordBotToken: result.data.DISCORD_BOT_TOKEN,
    httpHost: result.data.LUNA_HTTP_HOST,
    httpPort: result.data.LUNA_HTTP_PORT,
    logLevel: result.data.LOG_LEVEL,
    ...(result.data.LUNA_HOME === undefined ? {} : { lunaHome: result.data.LUNA_HOME }),
  };
}
