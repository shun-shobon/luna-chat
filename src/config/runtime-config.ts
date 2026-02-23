export type RuntimeConfig = {
  discordBotToken: string;
  allowedChannelIds: ReadonlySet<string>;
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

  return {
    discordBotToken,
    allowedChannelIds: parseAllowedChannelIds(env["ALLOWED_CHANNEL_IDS"]),
  };
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
