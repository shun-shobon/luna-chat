import { accessSync, constants, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

export type RuntimeConfig = {
  discordBotToken: string;
  allowedChannelIds: ReadonlySet<string>;
  contextFetchLimit: number;
  codexWorkspaceDir: string;
  apologyTemplatePath: string;
  codexAppServerApprovalPolicy: string;
  codexAppServerCommand: string;
  codexAppServerCwd: string;
  codexAppServerModel: string;
  codexAppServerSandbox: string;
  codexAppServerTimeoutMs: number;
};

const DEFAULT_CODEX_APP_SERVER_COMMAND = "codex app-server --listen stdio://";

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

  const codexWorkspaceDir = parseWorkspaceDir(env["CODEX_WORKSPACE_DIR"]);
  const apologyTemplatePath = parseApologyTemplatePath(
    env["APOLOGY_TEMPLATE_PATH"],
    codexWorkspaceDir,
  );
  const codexAppServerCwd = parseCodexAppServerCwd(env["CODEX_APP_SERVER_CWD"]);
  const codexAppServerModel = env["CODEX_APP_SERVER_MODEL"]?.trim() ?? "gpt-5.1-codex";
  const codexAppServerApprovalPolicy = parseCodexAppServerApprovalPolicy(
    env["CODEX_APP_SERVER_APPROVAL_POLICY"],
  );
  const codexAppServerSandbox = parseCodexAppServerSandbox(env["CODEX_APP_SERVER_SANDBOX"]);
  const codexAppServerTimeoutMs = parseCodexAppServerTimeoutMs(env["CODEX_APP_SERVER_TIMEOUT_MS"]);

  const runtimeConfig: RuntimeConfig = {
    discordBotToken,
    allowedChannelIds: parseAllowedChannelIds(env["ALLOWED_CHANNEL_IDS"]),
    contextFetchLimit: parseContextFetchLimit(env["CONTEXT_FETCH_LIMIT"]),
    codexWorkspaceDir,
    apologyTemplatePath,
    codexAppServerCommand: DEFAULT_CODEX_APP_SERVER_COMMAND,
    codexAppServerApprovalPolicy,
    codexAppServerCwd,
    codexAppServerModel,
    codexAppServerSandbox,
    codexAppServerTimeoutMs,
  };

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

function parseCodexAppServerTimeoutMs(rawTimeoutMs: string | undefined): number {
  if (!rawTimeoutMs) {
    return 60_000;
  }

  const parsedTimeoutMs = Number.parseInt(rawTimeoutMs, 10);
  if (Number.isNaN(parsedTimeoutMs) || parsedTimeoutMs <= 0) {
    throw new RuntimeConfigError("CODEX_APP_SERVER_TIMEOUT_MS must be a positive integer.");
  }

  return parsedTimeoutMs;
}

function parseCodexAppServerApprovalPolicy(rawPolicy: string | undefined): string {
  const value = rawPolicy?.trim() ?? "never";
  const allowedValues = new Set(["untrusted", "on-failure", "on-request", "never"]);
  if (!allowedValues.has(value)) {
    throw new RuntimeConfigError(
      "CODEX_APP_SERVER_APPROVAL_POLICY must be one of: untrusted, on-failure, on-request, never.",
    );
  }

  return value;
}

function parseCodexAppServerSandbox(rawSandbox: string | undefined): string {
  const value = rawSandbox?.trim() ?? "workspace-write";
  const allowedValues = new Set(["read-only", "workspace-write", "danger-full-access"]);
  if (!allowedValues.has(value)) {
    throw new RuntimeConfigError(
      "CODEX_APP_SERVER_SANDBOX must be one of: read-only, workspace-write, danger-full-access.",
    );
  }

  return value;
}

function parseWorkspaceDir(rawWorkspaceDir: string | undefined): string {
  if (!rawWorkspaceDir) {
    throw new RuntimeConfigError("CODEX_WORKSPACE_DIR is required.");
  }

  const resolvedWorkspaceDir = resolve(process.cwd(), rawWorkspaceDir);
  assertDirectoryExistsAndWritable(
    resolvedWorkspaceDir,
    "CODEX_WORKSPACE_DIR must exist and be writable.",
  );

  return resolvedWorkspaceDir;
}

function parseCodexAppServerCwd(rawCwd: string | undefined): string {
  const cwd = rawCwd?.trim() ? resolve(process.cwd(), rawCwd) : process.cwd();
  assertDirectoryExistsAndWritable(cwd, "CODEX_APP_SERVER_CWD must be writable.");

  return cwd;
}

function parseApologyTemplatePath(
  rawApologyTemplatePath: string | undefined,
  workspaceDir: string,
): string {
  if (!rawApologyTemplatePath) {
    throw new RuntimeConfigError("APOLOGY_TEMPLATE_PATH is required.");
  }

  const resolvedApologyTemplatePath = resolve(process.cwd(), rawApologyTemplatePath);
  const workspacePrefix = `${workspaceDir}${sep}`;
  if (
    resolvedApologyTemplatePath !== workspaceDir &&
    !resolvedApologyTemplatePath.startsWith(workspacePrefix)
  ) {
    throw new RuntimeConfigError("APOLOGY_TEMPLATE_PATH must be under CODEX_WORKSPACE_DIR.");
  }

  if (!existsSync(resolvedApologyTemplatePath)) {
    throw new RuntimeConfigError("APOLOGY_TEMPLATE_PATH must exist.");
  }
  if (!statSync(resolvedApologyTemplatePath).isFile()) {
    throw new RuntimeConfigError("APOLOGY_TEMPLATE_PATH must be a file.");
  }
  accessSync(resolvedApologyTemplatePath, constants.R_OK);

  return resolvedApologyTemplatePath;
}

function assertDirectoryExistsAndWritable(path: string, message: string): void {
  if (!existsSync(path)) {
    throw new RuntimeConfigError(message);
  }
  if (!statSync(path).isDirectory()) {
    throw new RuntimeConfigError(message);
  }
  accessSync(path, constants.W_OK);
}
