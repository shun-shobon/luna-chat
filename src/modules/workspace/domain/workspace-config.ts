export type WorkspaceConfig = {
  agent: {
    restartFailureLimit: number;
    restartInitialDelayMs: number;
    restartMaxDelayMs: number;
    restartWindowMs: number;
    rpcTimeoutMs: number;
    threadCleanupIntervalMs: number;
    threadRetentionMs: number;
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
};

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  agent: {
    restartFailureLimit: 5,
    restartInitialDelayMs: 1_000,
    restartMaxDelayMs: 30_000,
    restartWindowMs: 300_000,
    rpcTimeoutMs: 30_000,
    threadCleanupIntervalMs: 86_400_000,
    threadRetentionMs: 2_592_000_000,
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
};
