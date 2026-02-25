import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_LUNA_HOME = "~/.luna";
const WORKSPACE_DIR_NAME = "workspace";
const CODEX_HOME_DIR_NAME = "codex";

export type RuntimeConfig = {
  discordBotToken: string;
  allowedChannelIds: ReadonlySet<string>;
  lunaHomeDir: string;
  codexHomeDir: string;
  codexWorkspaceDir: string;
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

  const allowedChannelIds = parseAllowedChannelIds(env["ALLOWED_CHANNEL_IDS"]);
  const lunaHomeDir = resolveLunaHome(env["LUNA_HOME"]);
  const codexWorkspaceDir = resolve(lunaHomeDir, WORKSPACE_DIR_NAME);
  const codexHomeDir = resolve(lunaHomeDir, CODEX_HOME_DIR_NAME);

  ensureDirectoryReady(lunaHomeDir, "LUNA_HOME must be a writable directory.");
  ensureDirectoryReady(codexWorkspaceDir, "workspace must be a writable directory.");
  ensureDirectoryReady(codexHomeDir, "codex home must be a writable directory.");

  return {
    allowedChannelIds,
    lunaHomeDir,
    codexHomeDir,
    codexWorkspaceDir,
    discordBotToken,
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

function resolveLunaHome(rawLunaHome: string | undefined): string {
  const configuredLunaHome = rawLunaHome?.trim();
  const lunaHome =
    configuredLunaHome && configuredLunaHome.length > 0 ? configuredLunaHome : DEFAULT_LUNA_HOME;

  return resolve(expandHomeDirectory(lunaHome));
}

function expandHomeDirectory(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

function ensureDirectoryReady(path: string, message: string): void {
  try {
    mkdirSync(path, {
      recursive: true,
    });
    if (!statSync(path).isDirectory()) {
      throw new RuntimeConfigError(message);
    }
    accessSync(path, constants.W_OK);
  } catch {
    throw new RuntimeConfigError(message);
  }
}
