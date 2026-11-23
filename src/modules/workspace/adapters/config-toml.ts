import { readFile, writeFile } from "node:fs/promises";

import { parse, stringify } from "smol-toml";
import { z } from "zod";

import { isValidFiveFieldCron } from "../domain/cron-expression";
import { DEFAULT_WORKSPACE_CONFIG, MINECRAFT_WORKER_NAME } from "../domain/workspace-config";
import type {
	MinecraftSetting,
	ModelSetting,
	TtsSetting,
	VoiceSetting,
	WorkerSetting,
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
const DEFAULT_MINECRAFT_DECISION_TIMEOUT_MS = 3000;
const DEFAULT_MINECRAFT_PLANNER_INTERVAL_MS = 60_000;

const discordSnowflake = z.string().regex(/^\d+$/u);
const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
const modelIdSchema = z.string().regex(/^[^/\s]+\/[^\s]+$/u, "model must be provider/model");

// 依頼元のツール入力で列挙値として渡すため、名前は識別子に使える文字に限る。
const workerNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/u);
const workerChoiceSchema = z.strictObject({
	model: modelIdSchema,
	thinking: thinkingSchema,
	description: z.string().trim().min(1).max(500),
});
const workerSettingSchema = z
	.strictObject({
		default: workerNameSchema,
		choices: z.record(workerNameSchema, workerChoiceSchema),
	})
	.refine((worker) => Object.hasOwn(worker.choices, worker.default), {
		message: "models.worker.default must name one of models.worker.choices.",
		path: ["default"],
	});

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
				worker: workerSettingSchema.default(
					toWorkerSettingToml(DEFAULT_WORKSPACE_CONFIG.models.worker),
				),
				minecraft: workerChoiceSchema.optional(),
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
				tts_emoji: z.boolean().optional(),
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
				if (voice.tts_engine === "voicevox" && voice.tts_emoji !== undefined) {
					context.addIssue({
						code: "custom",
						message: 'voice.tts_emoji is not used with tts_engine = "voicevox".',
						path: ["tts_emoji"],
					});
				}
			})
			.optional(),
		minecraft: z
			.strictObject({
				host: z.string().trim().min(1),
				port: z.number().int().min(1).max(65_535),
				username: z.string().regex(/^[A-Za-z0-9_]{3,16}$/u),
				world: workerNameSchema,
				decision_model: modelIdSchema,
				decision_timeout_ms: positiveTimerMs.default(DEFAULT_MINECRAFT_DECISION_TIMEOUT_MS),
				planner_interval_ms: positiveTimerMs.default(DEFAULT_MINECRAFT_PLANNER_INTERVAL_MS),
			})
			.optional(),
	})
	.superRefine((config, context) => {
		if ((config.minecraft === undefined) !== (config.models.minecraft === undefined)) {
			context.addIssue({
				code: "custom",
				message: "minecraft and models.minecraft must be written together.",
				path: ["models", "minecraft"],
			});
		}
		if (Object.hasOwn(config.models.worker.choices, MINECRAFT_WORKER_NAME)) {
			context.addIssue({
				code: "custom",
				message: `models.worker.choices must not use the name "${MINECRAFT_WORKER_NAME}".`,
				path: ["models", "worker", "choices", MINECRAFT_WORKER_NAME],
			});
		}
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
			worker: toWorkerSetting(config.models.worker),
		},
		tasks: {
			maxConcurrent: config.tasks.max_concurrent,
		},
		...(config.voice === undefined ? {} : { voice: toVoiceSetting(config.voice) }),
		...(config.minecraft === undefined || config.models.minecraft === undefined
			? {}
			: { minecraft: toMinecraftSetting(config.minecraft, config.models.minecraft) }),
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
			worker: toWorkerSettingToml(config.models.worker),
			...(config.minecraft === undefined
				? {}
				: { minecraft: toWorkerChoiceToml(config.minecraft.planner) }),
		},
		tasks: {
			max_concurrent: config.tasks.maxConcurrent,
		},
		...(config.voice === undefined ? {} : { voice: toVoiceSettingToml(config.voice) }),
		...(config.minecraft === undefined
			? {}
			: { minecraft: toMinecraftSettingToml(config.minecraft) }),
	};
}

type MinecraftSettingToml = NonNullable<WorkspaceConfigToml["minecraft"]>;
type WorkerChoiceToml = z.infer<typeof workerChoiceSchema>;

function toMinecraftSetting(
	setting: MinecraftSettingToml,
	planner: WorkerChoiceToml,
): MinecraftSetting {
	return {
		host: setting.host,
		port: setting.port,
		username: setting.username,
		world: setting.world,
		decisionModel: splitModelId(setting.decision_model),
		decisionTimeoutMs: setting.decision_timeout_ms,
		plannerIntervalMs: setting.planner_interval_ms,
		planner: { ...toModelSetting(planner), description: planner.description },
	};
}

function toMinecraftSettingToml(setting: MinecraftSetting): MinecraftSettingToml {
	return {
		host: setting.host,
		port: setting.port,
		username: setting.username,
		world: setting.world,
		decision_model: `${setting.decisionModel.provider}/${setting.decisionModel.model}`,
		decision_timeout_ms: setting.decisionTimeoutMs,
		planner_interval_ms: setting.plannerIntervalMs,
	};
}

function toWorkerChoiceToml(setting: MinecraftSetting["planner"]): WorkerChoiceToml {
	return { ...toModelSettingToml(setting), description: setting.description };
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
			: { tts_voice: setting.tts.voice, tts_emoji: setting.tts.emoji }),
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
	return {
		engine: "speech-cpp",
		url,
		voice: setting.tts_voice,
		speed: setting.tts_speed,
		emoji: setting.tts_emoji ?? false,
	};
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

type WorkerSettingToml = z.infer<typeof workerSettingSchema>;

function toWorkerSetting(setting: WorkerSettingToml): WorkerSetting {
	return {
		default: setting.default,
		choices: Object.fromEntries(
			Object.entries(setting.choices).map(([name, choice]) => [
				name,
				{ ...toModelSetting(choice), description: choice.description },
			]),
		),
	};
}

function toWorkerSettingToml(setting: WorkerSetting): WorkerSettingToml {
	return {
		default: setting.default,
		choices: Object.fromEntries(
			Object.entries(setting.choices).map(([name, choice]) => [
				name,
				{ ...toModelSettingToml(choice), description: choice.description },
			]),
		),
	};
}
