import { readFile, writeFile } from "node:fs/promises";

import { parse, stringify } from "smol-toml";
import { z } from "zod";

import { isValidFiveFieldCron } from "../domain/cron-expression";
import { DEFAULT_WORKSPACE_CONFIG } from "../domain/workspace-config";
import type { ModelSetting, WorkspaceConfig } from "../domain/workspace-config";

const positiveSafeInteger = z.number().int().min(1);
const nonNegativeSafeInteger = z.number().int().min(0);
// Node.jsのsetTimeoutは2^31-1msを超えると1msに丸めるため、タイマーに渡す値はここで上限を課す。
const MAXIMUM_TIMER_MS = 2_147_483_647;
const positiveTimerMs = positiveSafeInteger.max(MAXIMUM_TIMER_MS);
const discordSnowflake = z.string().regex(/^\d+$/u);
const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
const modelIdSchema = z.string().regex(/^[^/\s]+\/[^\s]+$/u, "model must be provider/model");

function modelSettingSchema(fallback: ModelSetting) {
	return z
		.strictObject({
			model: modelIdSchema.default(`${fallback.provider}/${fallback.model}`),
			thinking: thinkingSchema.default(fallback.thinking),
		})
		.prefault({});
}

const WorkspaceConfigTomlSchema = z
	.strictObject({
		agent: z
			.strictObject({
				request_timeout_ms: positiveTimerMs.default(
					DEFAULT_WORKSPACE_CONFIG.agent.requestTimeoutMs,
				),
				transcript_cleanup_interval_ms: positiveTimerMs.default(
					DEFAULT_WORKSPACE_CONFIG.agent.transcriptCleanupIntervalMs,
				),
				transcript_retention_ms: positiveSafeInteger.default(
					DEFAULT_WORKSPACE_CONFIG.agent.transcriptRetentionMs,
				),
			})
			.prefault({}),
		discord: z
			.strictObject({
				allowed_channel_ids: z
					.array(discordSnowflake)
					.default(DEFAULT_WORKSPACE_CONFIG.discord.allowedChannelIds),
				allow_dm: z.boolean().default(DEFAULT_WORKSPACE_CONFIG.discord.allowDm),
				debounce_ms: positiveTimerMs.default(DEFAULT_WORKSPACE_CONFIG.discord.debounceMs),
				initial_history_limit: nonNegativeSafeInteger.default(
					DEFAULT_WORKSPACE_CONFIG.discord.initialHistoryLimit,
				),
				session_idle_ms: positiveTimerMs.default(DEFAULT_WORKSPACE_CONFIG.discord.sessionIdleMs),
				typing_idle_ms: positiveTimerMs.default(DEFAULT_WORKSPACE_CONFIG.discord.typingIdleMs),
			})
			.prefault({}),
		heartbeat: z
			.strictObject({
				enabled: z.boolean().default(DEFAULT_WORKSPACE_CONFIG.heartbeat.enabled),
				max_interval_ms: positiveTimerMs.default(DEFAULT_WORKSPACE_CONFIG.heartbeat.maxIntervalMs),
				min_interval_ms: positiveTimerMs.default(DEFAULT_WORKSPACE_CONFIG.heartbeat.minIntervalMs),
			})
			.prefault({}),
		memory: z.strictObject({
			enabled: z.boolean(),
			maintenance_cron: z.string().refine(isValidFiveFieldCron, {
				message: "memory.maintenance_cron must be a valid five-field cron expression.",
			}),
		}),
		models: z
			.strictObject({
				compaction: modelSettingSchema(DEFAULT_WORKSPACE_CONFIG.models.compaction),
				conversation: modelSettingSchema(DEFAULT_WORKSPACE_CONFIG.models.conversation),
				event: modelSettingSchema(DEFAULT_WORKSPACE_CONFIG.models.event),
				worker: modelSettingSchema(DEFAULT_WORKSPACE_CONFIG.models.worker),
			})
			.prefault({}),
		tasks: z
			.strictObject({
				max_concurrent: positiveSafeInteger.default(DEFAULT_WORKSPACE_CONFIG.tasks.maxConcurrent),
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
	return stringify(toWorkspaceConfigToml(config));
}

export async function createWorkspaceConfigFile(configPath: string): Promise<void> {
	await writeFile(configPath, serializeWorkspaceConfig(DEFAULT_WORKSPACE_CONFIG), { flag: "wx" });
}

function toWorkspaceConfig(config: WorkspaceConfigToml): WorkspaceConfig {
	return {
		agent: {
			requestTimeoutMs: config.agent.request_timeout_ms,
			transcriptCleanupIntervalMs: config.agent.transcript_cleanup_interval_ms,
			transcriptRetentionMs: config.agent.transcript_retention_ms,
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
		memory: {
			enabled: config.memory.enabled,
			maintenanceCron: config.memory.maintenance_cron,
		},
		models: {
			compaction: toModelSetting(config.models.compaction),
			conversation: toModelSetting(config.models.conversation),
			event: toModelSetting(config.models.event),
			worker: toModelSetting(config.models.worker),
		},
		tasks: {
			maxConcurrent: config.tasks.max_concurrent,
		},
	};
}

function toWorkspaceConfigToml(config: WorkspaceConfig): WorkspaceConfigToml {
	return {
		agent: {
			request_timeout_ms: config.agent.requestTimeoutMs,
			transcript_cleanup_interval_ms: config.agent.transcriptCleanupIntervalMs,
			transcript_retention_ms: config.agent.transcriptRetentionMs,
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
		memory: {
			enabled: config.memory.enabled,
			maintenance_cron: config.memory.maintenanceCron,
		},
		models: {
			compaction: toModelSettingToml(config.models.compaction),
			conversation: toModelSettingToml(config.models.conversation),
			event: toModelSettingToml(config.models.event),
			worker: toModelSettingToml(config.models.worker),
		},
		tasks: {
			max_concurrent: config.tasks.maxConcurrent,
		},
	};
}

function toModelSetting(setting: WorkspaceConfigToml["models"]["event"]): ModelSetting {
	const separator = setting.model.indexOf("/");
	return {
		provider: setting.model.slice(0, separator),
		model: setting.model.slice(separator + 1),
		thinking: setting.thinking,
	};
}

function toModelSettingToml(setting: ModelSetting): WorkspaceConfigToml["models"]["event"] {
	return { model: `${setting.provider}/${setting.model}`, thinking: setting.thinking };
}
