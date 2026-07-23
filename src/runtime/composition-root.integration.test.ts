import { afterEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  const client = {
    destroy: vi.fn(async () => undefined),
    login: vi.fn(async () => "token"),
    off: vi.fn(),
    on: vi.fn(),
    user: { id: "100" },
  };
  const managedClose = vi.fn(async () => undefined);
  const mcpClose = vi.fn(async () => undefined);
  return { client, managedClose, mcpClose };
});

vi.mock("../modules/workspace/adapters/initialize-workspace", () => ({
  initializeWorkspace: vi.fn(async () => ({
    codexHomeDir: "/tmp/luna-test/codex",
    config: {
      agent: {
        restartFailureLimit: 2,
        restartInitialDelayMs: 0,
        restartMaxDelayMs: 1_000,
        restartWindowMs: 10_000,
        rpcTimeoutMs: 1_000,
        threadCleanupIntervalMs: 86_400_000,
        threadRetentionMs: 2_592_000_000,
      },
      discord: {
        allowDm: true,
        allowedChannelIds: [],
        debounceMs: 100,
        initialHistoryLimit: 20,
        sessionIdleMs: 1_000,
        typingIdleMs: 50,
      },
      heartbeat: { enabled: false, maxIntervalMs: 2_000, minIntervalMs: 1_000 },
    },
    configPath: "/tmp/luna-test/config.toml",
    cronPath: "/tmp/luna-test/workspace/cron.toml",
    lunaHomeDir: "/tmp/luna-test",
    schedule: { jobs: [] },
    workspaceDir: "/tmp/luna-test/workspace",
  })),
}));

vi.mock("../modules/agent/adapters/outbound/codex/managed-codex-runtime", () => ({
  startManagedCodexRuntime: vi.fn(async () => ({
    close: fakes.managedClose,
    onFailure: vi.fn(() => () => undefined),
    port: {
      archiveThread: vi.fn(async () => undefined),
      deleteThread: vi.fn(async () => undefined),
      interruptTurn: vi.fn(async () => undefined),
      listThreads: vi.fn(async () => ({ data: [] })),
      openThread: vi.fn(async () => "thread-1"),
      startTurn: vi.fn(),
      steerTurn: vi.fn(async () => undefined),
    },
  })),
}));

vi.mock("../modules/discord/adapters/discord-gateway-adapter", async (importOriginal) => ({
  ...(await importOriginal()),
  createDiscordGatewayClient: vi.fn(() => fakes.client),
  createDiscordGatewayEventClient: vi.fn(() => ({ on: fakes.client.on, off: fakes.client.off })),
}));

vi.mock("../modules/discord/adapters/discord-mcp-server", () => ({
  startDiscordMcpServer: vi.fn(async () => ({
    close: fakes.mcpClose,
    url: "http://127.0.0.1:12345/mcp",
  })),
}));

vi.mock("../modules/automation/adapters/chokidar-schedule-watcher", () => ({
  ChokidarScheduleWatcher: class {
    async start(): Promise<void> {}
    async close(): Promise<void> {}
  },
}));

import { startLunaApplication } from "./composition-root";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
  vi.clearAllMocks();
});

describe("composition root integration", () => {
  it("fake Discordとfake app-serverでstartupからgraceful shutdownまで接続する", async () => {
    process.env = {
      ...originalEnvironment,
      DISCORD_BOT_TOKEN: "discord-token",
      LOG_LEVEL: "error",
      LUNA_HOME: "/tmp/luna-test",
    };

    const application = await startLunaApplication();

    expect(fakes.client.login).toHaveBeenCalledWith("discord-token");
    expect(fakes.client.on).toHaveBeenCalledTimes(2);

    await application.shutdown();

    expect(fakes.client.off).toHaveBeenCalledTimes(2);
    expect(fakes.mcpClose).toHaveBeenCalledOnce();
    expect(fakes.client.destroy).toHaveBeenCalledOnce();
    expect(fakes.managedClose).toHaveBeenCalledOnce();
  });

  it("startup中のabortでDiscord接続とchild runtimeを閉じる", async () => {
    process.env = {
      ...originalEnvironment,
      DISCORD_BOT_TOKEN: "discord-token",
      LOG_LEVEL: "error",
      LUNA_HOME: "/tmp/luna-test",
    };
    const login = deferred<string>();
    fakes.client.login.mockImplementationOnce(async () => await login.promise);
    fakes.client.destroy.mockImplementationOnce(async () => {
      login.reject(new Error("Discord login aborted"));
    });
    const controller = new AbortController();
    const starting = startLunaApplication({ startupSignal: controller.signal });
    await vi.waitFor(() => expect(fakes.client.login).toHaveBeenCalledOnce());

    controller.abort();

    await expect(starting).rejects.toThrow("Discord login aborted");
    expect(fakes.client.destroy).toHaveBeenCalled();
    expect(fakes.managedClose).toHaveBeenCalled();
    expect(fakes.mcpClose).toHaveBeenCalled();
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  reject(error: Error): void;
} {
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((_resolve, reject) => {
    rejectPromise = reject;
  });
  return {
    promise,
    reject(error) {
      if (rejectPromise === undefined) throw new Error("deferred is not initialized");
      rejectPromise(error);
    },
  };
}
