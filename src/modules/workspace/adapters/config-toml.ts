import { readFile, writeFile } from "node:fs/promises";

import { parse, stringify } from "smol-toml";
import { z } from "zod";

import { DEFAULT_WORKSPACE_CONFIG, type WorkspaceConfig } from "../domain/workspace-config";

const positiveSafeInteger = z.number().int().min(1);
const nonNegativeSafeInteger = z.number().int().min(0);
const discordSnowflake = z.string().regex(/^\d+$/);

const WorkspaceConfigTomlSchema = z
  .strictObject({
    agent: z
      .strictObject({
        restart_failure_limit: positiveSafeInteger.default(
          DEFAULT_WORKSPACE_CONFIG.agent.restartFailureLimit,
        ),
        restart_initial_delay_ms: nonNegativeSafeInteger.default(
          DEFAULT_WORKSPACE_CONFIG.agent.restartInitialDelayMs,
        ),
        restart_max_delay_ms: nonNegativeSafeInteger.default(
          DEFAULT_WORKSPACE_CONFIG.agent.restartMaxDelayMs,
        ),
        restart_window_ms: positiveSafeInteger.default(
          DEFAULT_WORKSPACE_CONFIG.agent.restartWindowMs,
        ),
        rpc_timeout_ms: positiveSafeInteger.default(DEFAULT_WORKSPACE_CONFIG.agent.rpcTimeoutMs),
        thread_cleanup_interval_ms: positiveSafeInteger.default(
          DEFAULT_WORKSPACE_CONFIG.agent.threadCleanupIntervalMs,
        ),
        thread_retention_ms: positiveSafeInteger.default(
          DEFAULT_WORKSPACE_CONFIG.agent.threadRetentionMs,
        ),
      })
      .prefault({}),
    discord: z
      .strictObject({
        allowed_channel_ids: z
          .array(discordSnowflake)
          .default(DEFAULT_WORKSPACE_CONFIG.discord.allowedChannelIds),
        allow_dm: z.boolean().default(DEFAULT_WORKSPACE_CONFIG.discord.allowDm),
        debounce_ms: positiveSafeInteger.default(DEFAULT_WORKSPACE_CONFIG.discord.debounceMs),
        initial_history_limit: nonNegativeSafeInteger.default(
          DEFAULT_WORKSPACE_CONFIG.discord.initialHistoryLimit,
        ),
        session_idle_ms: positiveSafeInteger.default(
          DEFAULT_WORKSPACE_CONFIG.discord.sessionIdleMs,
        ),
        typing_idle_ms: positiveSafeInteger.default(DEFAULT_WORKSPACE_CONFIG.discord.typingIdleMs),
      })
      .prefault({}),
    heartbeat: z
      .strictObject({
        enabled: z.boolean().default(DEFAULT_WORKSPACE_CONFIG.heartbeat.enabled),
        max_interval_ms: positiveSafeInteger.default(
          DEFAULT_WORKSPACE_CONFIG.heartbeat.maxIntervalMs,
        ),
        min_interval_ms: positiveSafeInteger.default(
          DEFAULT_WORKSPACE_CONFIG.heartbeat.minIntervalMs,
        ),
      })
      .prefault({}),
  })
  .superRefine((config, context) => {
    if (config.heartbeat.min_interval_ms > config.heartbeat.max_interval_ms) {
      context.addIssue({
        code: "custom",
        message: "heartbeat.min_interval_ms must be less than or equal to max_interval_ms.",
        path: ["heartbeat", "min_interval_ms"],
      });
    }
    if (config.agent.restart_initial_delay_ms > config.agent.restart_max_delay_ms) {
      context.addIssue({
        code: "custom",
        message:
          "agent.restart_initial_delay_ms must be less than or equal to restart_max_delay_ms.",
        path: ["agent", "restart_initial_delay_ms"],
      });
    }
  });

type WorkspaceConfigToml = z.infer<typeof WorkspaceConfigTomlSchema>;

class WorkspaceConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceConfigError";
  }
}

export async function readWorkspaceConfig(configPath: string): Promise<WorkspaceConfig> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error: unknown) {
    throw new WorkspaceConfigError("config.toml must be readable.", { cause: error });
  }

  return parseWorkspaceConfig(source);
}

export function parseWorkspaceConfig(source: string): WorkspaceConfig {
  let parsedToml: unknown;
  try {
    parsedToml = parse(source);
  } catch (error: unknown) {
    throw new WorkspaceConfigError("config.toml is invalid TOML.", { cause: error });
  }

  const result = WorkspaceConfigTomlSchema.safeParse(parsedToml);
  if (!result.success) {
    throw new WorkspaceConfigError(`config.toml is invalid: ${z.prettifyError(result.error)}`);
  }

  return toWorkspaceConfig(result.data);
}

export function serializeWorkspaceConfig(config: WorkspaceConfig): string {
  const toml = toWorkspaceConfigToml(config);
  const validationResult = WorkspaceConfigTomlSchema.safeParse(toml);
  if (!validationResult.success) {
    throw new WorkspaceConfigError(
      `workspace config cannot be serialized: ${z.prettifyError(validationResult.error)}`,
    );
  }

  return stringify(toml);
}

export async function createWorkspaceConfigFile(
  configPath: string,
  config: WorkspaceConfig = DEFAULT_WORKSPACE_CONFIG,
): Promise<void> {
  await writeFile(configPath, serializeWorkspaceConfig(config), { flag: "wx" });
}

function toWorkspaceConfig(config: WorkspaceConfigToml): WorkspaceConfig {
  return {
    agent: {
      restartFailureLimit: config.agent.restart_failure_limit,
      restartInitialDelayMs: config.agent.restart_initial_delay_ms,
      restartMaxDelayMs: config.agent.restart_max_delay_ms,
      restartWindowMs: config.agent.restart_window_ms,
      rpcTimeoutMs: config.agent.rpc_timeout_ms,
      threadCleanupIntervalMs: config.agent.thread_cleanup_interval_ms,
      threadRetentionMs: config.agent.thread_retention_ms,
    },
    discord: {
      allowDm: config.discord.allow_dm,
      allowedChannelIds: [...config.discord.allowed_channel_ids],
      debounceMs: config.discord.debounce_ms,
      initialHistoryLimit: config.discord.initial_history_limit,
      sessionIdleMs: config.discord.session_idle_ms,
      typingIdleMs: config.discord.typing_idle_ms,
    },
    heartbeat: {
      enabled: config.heartbeat.enabled,
      maxIntervalMs: config.heartbeat.max_interval_ms,
      minIntervalMs: config.heartbeat.min_interval_ms,
    },
  };
}

function toWorkspaceConfigToml(config: WorkspaceConfig): WorkspaceConfigToml {
  return {
    agent: {
      restart_failure_limit: config.agent.restartFailureLimit,
      restart_initial_delay_ms: config.agent.restartInitialDelayMs,
      restart_max_delay_ms: config.agent.restartMaxDelayMs,
      restart_window_ms: config.agent.restartWindowMs,
      rpc_timeout_ms: config.agent.rpcTimeoutMs,
      thread_cleanup_interval_ms: config.agent.threadCleanupIntervalMs,
      thread_retention_ms: config.agent.threadRetentionMs,
    },
    discord: {
      allowed_channel_ids: [...config.discord.allowedChannelIds],
      allow_dm: config.discord.allowDm,
      debounce_ms: config.discord.debounceMs,
      initial_history_limit: config.discord.initialHistoryLimit,
      session_idle_ms: config.discord.sessionIdleMs,
      typing_idle_ms: config.discord.typingIdleMs,
    },
    heartbeat: {
      enabled: config.heartbeat.enabled,
      max_interval_ms: config.heartbeat.maxIntervalMs,
      min_interval_ms: config.heartbeat.minIntervalMs,
    },
  };
}
