type ThinkingSetting = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ModelSetting = Readonly<{ provider: string; model: string; thinking: ThinkingSetting }>;

// 依頼元のエージェントが名前で選ぶ作業エージェントのモデル。説明は選ぶ手がかりとしてモデルに見せる。
type WorkerChoiceSetting = Readonly<ModelSetting & { description: string }>;

export type WorkerSetting = Readonly<{
	default: string;
	choices: Readonly<Record<string, WorkerChoiceSetting>>;
}>;

export type WorkspaceConfig = {
	agent: {
		requestTimeoutMs: number;
		transcriptCleanupEnabled: boolean;
		transcriptCleanupIntervalMs: number;
		transcriptRetentionMs: number;
	};
	discord: {
		allowDm: boolean;
		allowedChannelIds: string[];
		debounceMs: number;
		initialHistoryLimit: number;
		sessionIdleMs: number;
		typingIdleMs: number;
	};
	heartbeat: {
		enabled: boolean;
		maxIntervalMs: number;
		minIntervalMs: number;
	};
	memory: {
		enabled: boolean;
		maintenanceCron: string;
	};
	models: {
		compaction: ModelSetting;
		conversation: ModelSetting;
		event: ModelSetting;
		// 音声モードで声の返事を担う速いモデル（表）。
		voice: ModelSetting;
		worker: WorkerSetting;
	};
	tasks: {
		maxConcurrent: number;
	};
	voice?: VoiceSetting;
	minecraft?: MinecraftSetting;
};

// task_create の worker に Minecraft の作業エージェントとして並ぶ名前。
export const MINECRAFT_WORKER_NAME = "minecraft";

// TOML では [minecraft] と [models.minecraft] に分かれるが、片方だけでは使えないため1つにまとめて持つ。
export type MinecraftSetting = Readonly<{
	host: string;
	port: number;
	username: string;
	world: string;
	decisionModel: Readonly<{ provider: string; model: string }>;
	decisionTimeoutMs: number;
	plannerIntervalMs: number;
	planner: WorkerChoiceSetting;
}>;

export type VoiceSetting = {
	sttModelKind: "nemo-ctc" | "nemo-transducer" | "transducer" | "sense-voice";
	sttModelDir: string;
	vadModel: string;
	sttThreads: number;
	silenceMs: number;
	turnWaitMs: number;
	unfinishedTurnWaitMs: number;
	interruptModel: Readonly<{ provider: string; model: string }>;
	tts: TtsSetting;
};

// voicevox は VOICEVOX 互換の HTTP API（AivisSpeech Engine など）、speech-cpp は speech.cpp の OpenAI 互換 API。
// emoji は、読み方の指示に絵文字を読むモデル（Irodori-TTS）かどうか。
export type TtsSetting =
	| Readonly<{ engine: "voicevox"; url: URL; speaker: number; speed: number }>
	| Readonly<{ engine: "speech-cpp"; url: URL; voice: string; speed: number; emoji: boolean }>;

const DEFAULT_MODEL: ModelSetting = {
	provider: "openai-codex",
	model: "gpt-6.2-sol",
	thinking: "medium",
};

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
	agent: {
		requestTimeoutMs: 300_000,
		transcriptCleanupEnabled: true,
		transcriptCleanupIntervalMs: 86_400_000,
		transcriptRetentionMs: 604_800_000,
	},
	discord: {
		allowDm: true,
		allowedChannelIds: [],
		debounceMs: 5_000,
		initialHistoryLimit: 20,
		sessionIdleMs: 1_800_000,
		typingIdleMs: 10_000,
	},
	heartbeat: {
		enabled: true,
		maxIntervalMs: 2_700_000,
		minIntervalMs: 900_000,
	},
	memory: {
		enabled: true,
		maintenanceCron: "0 4 * * *",
	},
	models: {
		compaction: { provider: "openai-codex", model: "gpt-6.1-terra", thinking: "low" },
		conversation: DEFAULT_MODEL,
		event: DEFAULT_MODEL,
		voice: { provider: "claude-code", model: "claude-haiku-5-5", thinking: "off" },
		worker: {
			default: "standard",
			choices: {
				standard: {
					provider: "claude-code",
					model: "claude-opus-5-5",
					thinking: "medium",
					description: "Most background work: research, coding, and file or media production.",
				},
				light: {
					provider: "claude-code",
					model: "claude-sonnet-5-5",
					thinking: "medium",
					description:
						"Simple, well-defined work such as collecting information or routine file edits.",
				},
				heavy: {
					provider: "claude-code",
					model: "claude-fable-5-2",
					thinking: "high",
					description:
						"Hard work that needs deep reasoning, such as complex implementation, debugging, or design.",
				},
			},
		},
	},
	tasks: {
		maxConcurrent: 2,
	},
};
