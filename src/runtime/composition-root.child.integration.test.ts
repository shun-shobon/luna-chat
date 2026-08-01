import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const client = {
    channels: {
      fetch: vi.fn(async () => ({
        isTextBased: () => true,
        messages: { fetch: vi.fn(async () => new Map()) },
      })),
    },
    destroy: vi.fn(async () => undefined),
    login: vi.fn(async () => "token"),
    off: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    }),
    user: { id: "999" },
  };
  return {
    client,
    emit(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    executablePath: "",
    lunaHome: "",
    workspaceDir: "",
  };
});

vi.mock("../modules/workspace/adapters/initialize-workspace", () => ({
  initializeWorkspace: vi.fn(async () => ({
    codexHomeDir: `${fakes.lunaHome}/codex`,
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
        allowedChannelIds: ["200"],
        debounceMs: 1,
        initialHistoryLimit: 20,
        sessionIdleMs: 1_000,
        typingIdleMs: 1,
      },
      heartbeat: { enabled: false, maxIntervalMs: 2_000, minIntervalMs: 1_000 },
      memory: { enabled: true, maintenanceCron: "0 4 * * *" },
    },
    configPath: `${fakes.lunaHome}/config.toml`,
    cronPath: `${fakes.workspaceDir}/cron.toml`,
    lunaHomeDir: fakes.lunaHome,
    schedule: { jobs: [] },
    workspaceDir: fakes.workspaceDir,
  })),
}));

vi.mock("../modules/agent/adapters/outbound/codex/codex-executable", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../modules/agent/adapters/outbound/codex/codex-executable")
  >()),
  resolveCodexExecutable: vi.fn(() => fakes.executablePath),
}));

vi.mock("../modules/discord/adapters/discord-gateway-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../modules/discord/adapters/discord-gateway-adapter")>()),
  createDiscordGatewayClient: vi.fn(() => fakes.client),
  createDiscordGatewayEventClient: vi.fn(() => ({ on: fakes.client.on, off: fakes.client.off })),
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

    scheduleRecurring(): { stop(): void } {
      return { stop() {} };
    }
  },
}));

import { startLunaApplication } from "./composition-root";

const temporaryDirectories: string[] = [];
const originalEnvironment = { ...process.env };

afterEach(async () => {
  process.env = { ...originalEnvironment };
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true })),
  );
  vi.clearAllMocks();
});

describe("composition root child integration", () => {
  it("fake Gateway/APIとfake app-server childを実transportでstartupからshutdownまで通す", async () => {
    const root = await mkdtemp(join(tmpdir(), "luna-composition-child-"));
    temporaryDirectories.push(root);
    fakes.lunaHome = join(root, "home");
    fakes.workspaceDir = join(fakes.lunaHome, "workspace");
    const rpcLogPath = join(root, "rpc.log");
    fakes.executablePath = join(root, "fake-codex");
    await mkdir(fakes.workspaceDir, { recursive: true });
    await Promise.all([
      writeFile(join(fakes.workspaceDir, "LUNA.md"), "Luna"),
      writeFile(join(fakes.workspaceDir, "MEMORY.md"), "Memory"),
      writeFile(fakes.executablePath, FAKE_CODEX_SCRIPT),
    ]);
    await chmod(fakes.executablePath, 0o755);
    process.env = {
      ...originalEnvironment,
      DISCORD_BOT_TOKEN: "discord-token",
      FAKE_CODEX_LOG: rpcLogPath,
      LOG_LEVEL: "error",
      LUNA_HOME: fakes.lunaHome,
    };

    const application = await startLunaApplication();
    fakes.emit("messageCreate", discordMessage());
    await vi.waitFor(
      async () => {
        const methods = (await readFile(rpcLogPath, "utf8")).trim().split("\n");
        expect(methods.filter((method) => method === "turn/start")).toHaveLength(2);
      },
      { timeout: 3_000 },
    );
    await application.shutdown();

    const methods = (await readFile(rpcLogPath, "utf8")).trim().split("\n");
    expect(methods).toEqual(
      expect.arrayContaining([
        "initialize",
        "thread/list",
        "thread/start",
        "turn/start",
        "thread/archive",
      ]),
    );
    expect(fakes.client.channels.fetch).toHaveBeenCalledWith("200", { force: true });
    expect(fakes.client.destroy).toHaveBeenCalledOnce();
  });
});

const FAKE_CODEX_SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method) fs.appendFileSync(process.env.FAKE_CODEX_LOG, message.method + "\\n");
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({ id: message.id, result: { codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "linux", userAgent: "fake-codex" } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: { backwardsCursor: null, data: [], nextCursor: null } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-1" } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({ method: "item/completed", params: { item: { phase: "final_answer", text: JSON.stringify({ actions: [] }), type: "agentMessage" }, threadId: "thread-1", turnId: "turn-1" } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { error: null, id: "turn-1", status: "completed" } } });
  } else if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
  } else {
    send({ id: message.id, result: {} });
  }
});
`;

function discordMessage() {
  return {
    id: "400",
    createdAt: new Date("2026-07-23T00:00:00.000Z"),
    system: false,
    guild: { id: "300", name: "Luna Lab" },
    channel: {
      id: "200",
      type: ChannelType.GuildText,
      name: "general",
      parentId: null,
      recipient: null,
    },
    author: { id: "100", username: "shun", globalName: "Shun", bot: false, system: false },
    member: { displayName: "Shun" },
    webhookId: null,
    content: "hello",
    attachments: new Map(),
    stickers: new Map(),
    reactions: { cache: new Map() },
    mentions: { users: new Map(), roles: new Map(), channels: new Map(), everyone: false },
    reference: null,
  };
}
