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
  const recurringCrons: string[] = [];
  const runtime = { failure: undefined as ((error: Error) => void) | undefined };
  return { client, managedClose, mcpClose, recurringCrons, runtime };
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
      memory: { enabled: true, maintenanceCron: "0 4 * * *" },
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
    onFailure: vi.fn((handler: (error: Error) => void) => {
      fakes.runtime.failure = handler;
      return () => undefined;
    }),
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

vi.mock("../modules/automation/adapters/cron-schedule-timer", () => ({
  CronScheduleTimer: class {
    scheduleOneShot(): never {
      throw new Error("Unexpected one-shot schedule");
    }

    scheduleRecurring(cron: string): { stop(): void } {
      fakes.recurringCrons.push(cron);
      return { stop() {} };
    }
  },
}));

import { ConversationCoordinator } from "../modules/conversation/application/conversation-coordinator";
import * as effectOutputModule from "../modules/effect/application/effect-output-contract";
import * as effectRegistryModule from "../modules/effect/application/effect-registry";
import { EventAgentAdapter } from "../modules/event/adapters/event-agent-adapter";

import { startLunaApplication } from "./composition-root";
import * as threadInputModule from "./thread-input-factory";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
  fakes.recurringCrons.length = 0;
  fakes.runtime.failure = undefined;
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

    const registry = vi.spyOn(effectRegistryModule, "createEffectRegistry");
    const outputContract = vi.spyOn(effectOutputModule, "createEffectOutputContract");
    const threadInputFactory = vi.spyOn(threadInputModule, "createThreadInputFactory");
    const application = await startLunaApplication();

    expect(fakes.client.login).toHaveBeenCalledWith("discord-token");
    expect(fakes.client.on).toHaveBeenCalledTimes(2);
    expect(fakes.recurringCrons).toEqual(["0 4 * * *"]);
    expect(registry).toHaveBeenCalledOnce();
    expect(registry.mock.calls[0]?.[0][0]?.definitions).toHaveLength(6);
    expect(outputContract).toHaveBeenCalledWith(registry.mock.results[0]?.value);
    const factoryInput = threadInputFactory.mock.calls[0]?.[0];
    expect(factoryInput?.capabilityInstructions).toHaveLength(1);
    expect(factoryInput?.buildMcpServers("owner-1")).toEqual({
      discord: {
        url: "http://127.0.0.1:12345/mcp",
        http_headers: { "X-Luna-Typing-Owner": "owner-1" },
      },
    });

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

  it("app-server connection lossを両実行経路へ通知し、fatal shutdownでは会話をabortする", async () => {
    process.env = {
      ...originalEnvironment,
      DISCORD_BOT_TOKEN: "discord-token",
      LOG_LEVEL: "error",
      LUNA_HOME: "/tmp/luna-test",
    };
    const conversationLost = vi.spyOn(ConversationCoordinator.prototype, "connectionLost");
    const eventLost = vi.spyOn(EventAgentAdapter.prototype, "connectionLost");
    const abort = vi.spyOn(ConversationCoordinator.prototype, "abort");
    const drain = vi.spyOn(ConversationCoordinator.prototype, "drain");
    const application = await startLunaApplication();
    const failure = new Error("connection lost");

    fakes.runtime.failure?.(failure);

    expect(conversationLost).toHaveBeenCalledWith(failure);
    expect(eventLost).toHaveBeenCalledOnce();
    await application.shutdown(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(drain).not.toHaveBeenCalled();
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
