type ThinkingSetting = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ModelSetting = Readonly<{ provider: string; model: string; thinking: ThinkingSetting }>;

export type WorkspaceConfig = {
	agent: {
		requestTimeoutMs: number;
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
		worker: ModelSetting;
	};
	tasks: {
		maxConcurrent: number;
	};
};

const DEFAULT_MODEL: ModelSetting = {
	provider: "openai-codex",
	model: "gpt-6.1-sol",
	thinking: "medium",
};

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
	agent: {
		requestTimeoutMs: 300_000,
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
		worker: DEFAULT_MODEL,
	},
	tasks: {
		maxConcurrent: 2,
	},
};
