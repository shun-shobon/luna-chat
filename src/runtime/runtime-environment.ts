import { z } from "zod";

import type { LogLevel } from "../modules/observability/ports/logger-port";

const RuntimeEnvironmentSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().refine((value) => value.trim().length > 0, "must not be blank"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  LUNA_HOME: z.string().optional(),
});

type RuntimeEnvironment = Readonly<{
  discordBotToken: string;
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
    logLevel: result.data.LOG_LEVEL,
    ...(result.data.LUNA_HOME === undefined ? {} : { lunaHome: result.data.LUNA_HOME }),
  };
}
