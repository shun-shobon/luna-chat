import { z } from "zod";

import type { LogLevel } from "../modules/observability/ports/logger-port";

const hostSchema = z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1");
const portSchema = z
	.string()
	.regex(/^\d+$/u)
	.transform(Number)
	.pipe(z.number().int().min(1).max(65_535));

const RuntimeEnvironmentSchema = z.object({
	DISCORD_BOT_TOKEN: z.string().refine((value) => value.trim().length > 0, "must not be blank"),
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
	LUNA_DASHBOARD_HOST: hostSchema,
	LUNA_DASHBOARD_PORT: portSchema.default(3001),
	LUNA_HTTP_HOST: hostSchema,
	LUNA_HTTP_PORT: portSchema.default(3000),
	LUNA_HOME: z.string().optional(),
});

type ListenHost = z.infer<typeof hostSchema>;

type RuntimeEnvironment = Readonly<{
	dashboardHost: ListenHost;
	dashboardPort: number;
	discordBotToken: string;
	httpHost: ListenHost;
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
		dashboardHost: result.data.LUNA_DASHBOARD_HOST,
		dashboardPort: result.data.LUNA_DASHBOARD_PORT,
		discordBotToken: result.data.DISCORD_BOT_TOKEN,
		httpHost: result.data.LUNA_HTTP_HOST,
		httpPort: result.data.LUNA_HTTP_PORT,
		logLevel: result.data.LOG_LEVEL,
		...(result.data.LUNA_HOME === undefined ? {} : { lunaHome: result.data.LUNA_HOME }),
	};
}
