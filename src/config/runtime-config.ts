export type RuntimeConfig = {
  discordBotToken: string;
  allowedChannelIds: ReadonlySet<string>;
  contextFetchLimit: number;
  codexAppServerCommand?: string;
};

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const discordBotToken = env["DISCORD_BOT_TOKEN"]?.trim();
  if (!discordBotToken) {
    throw new RuntimeConfigError("DISCORD_BOT_TOKEN is required.");
  }

  const codexAppServerCommand = env["CODEX_APP_SERVER_COMMAND"]?.trim();

  const runtimeConfig: RuntimeConfig = {
    discordBotToken,
    allowedChannelIds: parseAllowedChannelIds(env["ALLOWED_CHANNEL_IDS"]),
    contextFetchLimit: parseContextFetchLimit(env["CONTEXT_FETCH_LIMIT"]),
  };
  if (codexAppServerCommand) {
    runtimeConfig.codexAppServerCommand = codexAppServerCommand;
  }

  return runtimeConfig;
}

function parseAllowedChannelIds(rawAllowedChannelIds: string | undefined): ReadonlySet<string> {
  if (!rawAllowedChannelIds) {
    throw new RuntimeConfigError("ALLOWED_CHANNEL_IDS is required.");
  }

  const allowedChannelIds = rawAllowedChannelIds
    .split(",")
    .map((channelId) => channelId.trim())
    .filter((channelId) => channelId.length > 0);

  if (allowedChannelIds.length === 0) {
    throw new RuntimeConfigError("ALLOWED_CHANNEL_IDS must include at least one channel ID.");
  }

  return new Set(allowedChannelIds);
}

function parseContextFetchLimit(rawContextFetchLimit: string | undefined): number {
  if (!rawContextFetchLimit) {
    return 30;
  }

  const parsedLimit = Number.parseInt(rawContextFetchLimit, 10);
  if (Number.isNaN(parsedLimit) || parsedLimit <= 0) {
    throw new RuntimeConfigError("CONTEXT_FETCH_LIMIT must be a positive integer.");
  }

  return parsedLimit;
}
