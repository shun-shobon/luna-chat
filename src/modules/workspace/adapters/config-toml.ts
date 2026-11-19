import { readFile, writeFile } from "node:fs/promises";

import { parse, stringify } from "smol-toml";
import { z } from "zod";

import { isValidFiveFieldCron } from "../domain/cron-expression";
import { DEFAULT_WORKSPACE_CONFIG } from "../domain/workspace-config";
import type {
	ModelSetting,
	TtsSetting,
	VoiceSetting,
	WorkspaceConfig,
} from "../domain/workspace-config";

const positiveSafeInteger = z.number().int().min(1);
const nonNegativeSafeInteger = z.number().int().min(0);
// Node.jsのsetTimeoutは2^31-1msを超えると1msに丸めるため、タイマーに渡す値はここで上限を課す。
const MAXIMUM_TIMER_MS = 2_147_483_647;
const positiveTimerMs = positiveSafeInteger.max(MAXIMUM_TIMER_MS);
const DEFAULT_VOICE_STT_THREADS = 2;
const DEFAULT_VOICE_SILENCE_MS = 300;
const DEFAULT_VOICE_TURN_WAIT_MS = 500;
const DEFAULT_VOICE_UNFINISHED_TURN_WAIT_MS = 3000;
const DEFAULT_VOICE_INTERRUPT_MODEL = "openai/gpt-6-luna";
const DEFAULT_VOICE_TTS_SPEED = 1;
const DEFAULT_VOICE_TTS_ENGINE = "voicevox";
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
				transcript_cleanup_enabled: z
					.boolean()
					.default(DEFAULT_WORKSPACE_CONFIG.agent.transcriptCleanupEnabled),
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
				voice: modelSettingSchema(DEFAULT_WORKSPACE_CONFIG.models.voice),
				worker: modelSettingSchema(DEFAULT_WORKSPACE_CONFIG.models.worker),
			})
			.prefault({}),
		tasks: z
			.strictObject({
				max_concurrent: positiveSafeInteger.default(DEFAULT_WORKSPACE_CONFIG.tasks.maxConcurrent),
			})
			.prefault({}),
		voice: z
			.strictObject({
				stt_model_kind: z.enum(["nemo-ctc", "nemo-transducer", "transducer", "sense-voice"]),
				stt_model_dir: z.string().min(1),
				vad_model: z.string().min(1),
				stt_threads: positiveSafeInteger.default(DEFAULT_VOICE_STT_THREADS),
				silence_ms: positiveTimerMs.default(DEFAULT_VOICE_SILENCE_MS),
				turn_wait_ms: positiveTimerMs.default(DEFAULT_VOICE_TURN_WAIT_MS),
				unfinished_turn_wait_ms: positiveTimerMs.default(DEFAULT_VOICE_UNFINISHED_TURN_WAIT_MS),
				interrupt_model: modelIdSchema.default(DEFAULT_VOICE_INTERRUPT_MODEL),
				tts_engine: z.enum(["voicevox", "speech-cpp"]).default(DEFAULT_VOICE_TTS_ENGINE),
				tts_url: z.url({ protocol: /^https?$/u }),
				tts_speaker: nonNegativeSafeInteger.optional(),
				tts_voice: z.string().min(1).optional(),
				tts_speed: z.number().min(0.5).max(2).default(DEFAULT_VOICE_TTS_SPEED),
			})
			.superRefine((voice, context) => {
				const [required, unused] =
					voice.tts_engine === "voicevox"
						? (["tts_speaker", "tts_voice"] as const)
						: (["tts_voice", "tts_speaker"] as const);
				if (voice[required] === undefined) {
					context.addIssue({
						code: "custom",
						message: `voice.${required} is required for tts_engine = "${voice.tts_engine}".`,
						path: [required],
					});
				}
				if (voice[unused] !== undefined) {
					context.addIssue({
						code: "custom",
						message: `voice.${unused} is not used with tts_engine = "${voice.tts_engine}".`,
						path: [unused],
					});
				}
			})
			.optional(),
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
			transcriptCleanupEnabled: config.agent.transcript_cleanup_enabled,
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
			voice: toModelSetting(config.models.voice),
			worker: toModelSetting(config.models.worker),
		},
		tasks: {
			maxConcurrent: config.tasks.max_concurrent,
		},
		...(config.voice === undefined ? {} : { voice: toVoiceSetting(config.voice) }),
	};
}

function toWorkspaceConfigToml(config: WorkspaceConfig): WorkspaceConfigToml {
	return {
		agent: {
			request_timeout_ms: config.agent.requestTimeoutMs,
			transcript_cleanup_enabled: config.agent.transcriptCleanupEnabled,
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
			voice: toModelSettingToml(config.models.voice),
			worker: toModelSettingToml(config.models.worker),
		},
		tasks: {
			max_concurrent: config.tasks.maxConcurrent,
		},
		...(config.voice === undefined ? {} : { voice: toVoiceSettingToml(config.voice) }),
	};
}

type VoiceSettingToml = NonNullable<WorkspaceConfigToml["voice"]>;

function toVoiceSetting(setting: VoiceSettingToml): VoiceSetting {
	return {
		sttModelKind: setting.stt_model_kind,
		sttModelDir: setting.stt_model_dir,
		vadModel: setting.vad_model,
		sttThreads: setting.stt_threads,
		silenceMs: setting.silence_ms,
		turnWaitMs: setting.turn_wait_ms,
		unfinishedTurnWaitMs: setting.unfinished_turn_wait_ms,
		interruptModel: splitModelId(setting.interrupt_model),
		tts: toTtsSetting(setting),
	};
}

function toVoiceSettingToml(setting: VoiceSetting): VoiceSettingToml {
	return {
		stt_model_kind: setting.sttModelKind,
		stt_model_dir: setting.sttModelDir,
		vad_model: setting.vadModel,
		stt_threads: setting.sttThreads,
		silence_ms: setting.silenceMs,
		turn_wait_ms: setting.turnWaitMs,
		unfinished_turn_wait_ms: setting.unfinishedTurnWaitMs,
		interrupt_model: `${setting.interruptModel.provider}/${setting.interruptModel.model}`,
		tts_engine: setting.tts.engine,
		tts_url: setting.tts.url.href,
		...(setting.tts.engine === "voicevox"
			? { tts_speaker: setting.tts.speaker }
			: { tts_voice: setting.tts.voice }),
		tts_speed: setting.tts.speed,
	};
}

function toTtsSetting(setting: VoiceSettingToml): TtsSetting {
	const url = new URL(setting.tts_url);
	if (setting.tts_engine === "voicevox") {
		if (setting.tts_speaker === undefined)
			throw new WorkspaceConfigError("voice.tts_speaker is required.");
		return { engine: "voicevox", url, speaker: setting.tts_speaker, speed: setting.tts_speed };
	}
	if (setting.tts_voice === undefined)
		throw new WorkspaceConfigError("voice.tts_voice is required.");
	return { engine: "speech-cpp", url, voice: setting.tts_voice, speed: setting.tts_speed };
}

function toModelSetting(setting: WorkspaceConfigToml["models"]["event"]): ModelSetting {
	return { ...splitModelId(setting.model), thinking: setting.thinking };
}

function splitModelId(id: string): Readonly<{ provider: string; model: string }> {
	const separator = id.indexOf("/");
	return { provider: id.slice(0, separator), model: id.slice(separator + 1) };
}

function toModelSettingToml(setting: ModelSetting): WorkspaceConfigToml["models"]["event"] {
	return { model: `${setting.provider}/${setting.model}`, thinking: setting.thinking };
}
