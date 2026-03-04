import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeMessage } from "../../conversation/domain/runtime-message";
import type { TurnResult } from "../domain/turn-result";
import type { DiscordPromptContext } from "../ports/inbound/ai-service-port";
import type { AiRuntimePort } from "../ports/outbound/ai-runtime-port";
import type { StartedTurn, TurnObserver } from "../ports/outbound/ai-runtime-port";

import { ChannelSessionCoordinator } from "./channel-session-coordinator";
import { buildThreadConfig } from "./thread-config-factory";

describe("ChannelSessionCoordinator", () => {
  it("進行中turnがある場合は steer を送る", async () => {
    const runtime = new FakeAiRuntime();
    const service = createService({
      createRuntime: vi.fn(() => runtime),
    });

    const firstPromise = service.generateReply(createAiInput("m1", "c1", "first"));
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    });

    await service.generateReply(createAiInput("m2", "c1", "second"));

    expect(runtime.steerTurn).toHaveBeenCalledTimes(1);
    expect(runtime.steerTurn).toHaveBeenCalledWith("thread-1", "turn-1", expect.any(String));

    runtime.completeTurn("turn-1", createCompletedTurnResult());
    await firstPromise;
  });

  it("turn完了後も同一threadを再利用する", async () => {
    const runtime = new FakeAiRuntime();
    const createRuntime = vi.fn(() => runtime);
    const service = createService({
      createRuntime,
    });

    const firstPromise = service.generateReply(createAiInput("m1", "c1", "first"));
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    });
    runtime.completeTurn("turn-1", createCompletedTurnResult());
    await firstPromise;

    const secondPromise = service.generateReply(createAiInput("m2", "c1", "second"));
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    });
    runtime.completeTurn("turn-2", createCompletedTurnResult());
    await secondPromise;

    expect(runtime.startThread).toHaveBeenCalledTimes(1);
    expect(runtime.startThread).toHaveBeenCalledWith({
      config: buildThreadConfig("http://127.0.0.1:43123/mcp", "/tmp/workspace", "/tmp/codex"),
      developerRolePrompt: expect.any(String),
      instructions: expect.any(String),
    });
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.startTurn).toHaveBeenNthCalledWith(
      1,
      "thread-1",
      expect.any(String),
      expect.any(Object),
      { timeoutMs: 10 * 60_000 },
    );
    expect(runtime.startTurn).toHaveBeenNthCalledWith(
      2,
      "thread-1",
      expect.any(String),
      expect.any(Object),
      { timeoutMs: 10 * 60_000 },
    );
  });

  it("別チャンネルも同一セッションに合流し turn 完了時コールバックを全チャンネルへ送る", async () => {
    const runtime = new FakeAiRuntime();
    const onDiscordTurnCompleted = vi.fn();
    const service = createService({
      createRuntime: vi.fn(() => runtime),
      onDiscordTurnCompleted,
    });

    const firstPromise = service.generateReply(createAiInput("m1", "c1", "first"));
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    });

    await service.generateReply(createAiInput("m2", "c2", "second"));

    expect(runtime.steerTurn).toHaveBeenCalledTimes(1);
    expect(runtime.steerTurn).toHaveBeenCalledWith("thread-1", "turn-1", expect.any(String));
    expect(runtime.steerTurn.mock.calls[0]?.[2]).toContain("チャンネル名: channel-c2");

    runtime.completeTurn("turn-1", createCompletedTurnResult());
    await firstPromise;

    expect(onDiscordTurnCompleted).toHaveBeenCalledTimes(2);
    expect(onDiscordTurnCompleted).toHaveBeenCalledWith("c1");
    expect(onDiscordTurnCompleted).toHaveBeenCalledWith("c2");
  });

  it("DM は同一ユーザーなら同一threadを再利用する", async () => {
    const runtime = new FakeAiRuntime();
    const service = createService({
      createRuntime: vi.fn(() => runtime),
    });

    const firstPromise = service.generateReply(
      createAiInput("m1", "dm-channel-1", "first", {
        authorId: "dm-user-1",
        context: { kind: "dm" },
      }),
    );
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    });
    runtime.completeTurn("turn-1", createCompletedTurnResult());
    await firstPromise;

    const secondPromise = service.generateReply(
      createAiInput("m2", "dm-channel-2", "second", {
        authorId: "dm-user-1",
        context: { kind: "dm" },
      }),
    );
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    });
    runtime.completeTurn("turn-2", createCompletedTurnResult());
    await secondPromise;

    expect(runtime.startThread).toHaveBeenCalledTimes(1);
    expect(runtime.startTurn).toHaveBeenNthCalledWith(
      1,
      "thread-1",
      expect.any(String),
      expect.any(Object),
      { timeoutMs: 10 * 60_000 },
    );
    expect(runtime.startTurn).toHaveBeenNthCalledWith(
      2,
      "thread-1",
      expect.any(String),
      expect.any(Object),
      { timeoutMs: 10 * 60_000 },
    );
  });

  it("DM はユーザーごとに別threadを使う", async () => {
    const runtime = new FakeAiRuntime();
    const service = createService({
      createRuntime: vi.fn(() => runtime),
    });

    const firstPromise = service.generateReply(
      createAiInput("m1", "dm-channel-1", "first", {
        authorId: "dm-user-1",
        context: { kind: "dm" },
      }),
    );
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    });
    runtime.completeTurn("turn-1", createCompletedTurnResult());
    await firstPromise;

    const secondPromise = service.generateReply(
      createAiInput("m2", "dm-channel-2", "second", {
        authorId: "dm-user-2",
        context: { kind: "dm" },
      }),
    );
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    });
    runtime.completeTurn("turn-2", createCompletedTurnResult());
    await secondPromise;

    expect(runtime.startThread).toHaveBeenCalledTimes(2);
    expect(runtime.startTurn).toHaveBeenNthCalledWith(
      1,
      "thread-1",
      expect.any(String),
      expect.any(Object),
      { timeoutMs: 10 * 60_000 },
    );
    expect(runtime.startTurn).toHaveBeenNthCalledWith(
      2,
      "thread-2",
      expect.any(String),
      expect.any(Object),
      { timeoutMs: 10 * 60_000 },
    );
  });

  it("チャンネルとDMは別threadになる", async () => {
    const runtime = new FakeAiRuntime();
    const service = createService({
      createRuntime: vi.fn(() => runtime),
    });

    const firstPromise = service.generateReply(createAiInput("m1", "c1", "channel-1"));
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    });
    runtime.completeTurn("turn-1", createCompletedTurnResult());
    await firstPromise;

    const secondPromise = service.generateReply(
      createAiInput("m2", "dm-channel-1", "dm-1", {
        authorId: "dm-user-1",
        context: { kind: "dm" },
      }),
    );
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    });
    runtime.completeTurn("turn-2", createCompletedTurnResult());
    await secondPromise;

    const thirdPromise = service.generateReply(createAiInput("m3", "c2", "channel-2"));
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(3);
    });
    runtime.completeTurn("turn-3", createCompletedTurnResult());
    await thirdPromise;

    expect(runtime.startThread).toHaveBeenCalledTimes(2);
    expect(runtime.startTurn).toHaveBeenNthCalledWith(
      1,
      "thread-1",
      expect.any(String),
      expect.any(Object),
      { timeoutMs: 10 * 60_000 },
    );
    expect(runtime.startTurn).toHaveBeenNthCalledWith(
      2,
      "thread-2",
      expect.any(String),
      expect.any(Object),
      { timeoutMs: 10 * 60_000 },
    );
    expect(runtime.startTurn).toHaveBeenNthCalledWith(
      3,
      "thread-1",
      expect.any(String),
      expect.any(Object),
      { timeoutMs: 10 * 60_000 },
    );
  });

  it("チャンネル履歴は未注入チャンネルの初回のみ取得する", async () => {
    const runtime = new FakeAiRuntime();
    const service = createService({
      createRuntime: vi.fn(() => runtime),
    });

    const loadHistoryC1 = vi.fn(async () => []);
    const loadHistoryC2 = vi.fn(async () => []);

    const firstPromise = service.generateReply(
      createAiInput("m1", "c1", "first", { loadRecentMessages: loadHistoryC1 }),
    );
    await vi.waitFor(() => {
      expect(loadHistoryC1).toHaveBeenCalledTimes(1);
    });
    runtime.completeTurn("turn-1", createCompletedTurnResult());
    await firstPromise;

    const secondPromise = service.generateReply(
      createAiInput("m2", "c1", "second", { loadRecentMessages: loadHistoryC1 }),
    );
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    });
    runtime.completeTurn("turn-2", createCompletedTurnResult());
    await secondPromise;

    expect(loadHistoryC1).toHaveBeenCalledTimes(1);

    const thirdPromise = service.generateReply(
      createAiInput("m3", "c2", "third", { loadRecentMessages: loadHistoryC2 }),
    );
    await vi.waitFor(() => {
      expect(loadHistoryC2).toHaveBeenCalledTimes(1);
    });
    runtime.completeTurn("turn-3", createCompletedTurnResult());
    await thirdPromise;
  });

  it("アイドルTTLはセッションごとに適用される", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const runtime = new FakeAiRuntime();
      const service = createService({
        createRuntime: vi.fn(() => runtime),
        now: () => now,
        sessionIdleMs: 1_000,
      });

      const channelFirst = service.generateReply(createAiInput("m1", "c1", "channel-1"));
      await vi.waitFor(() => {
        expect(runtime.startTurn).toHaveBeenCalledTimes(1);
      });
      runtime.completeTurn("turn-1", createCompletedTurnResult());
      await channelFirst;

      const dmFirst = service.generateReply(
        createAiInput("m2", "dm-channel-1", "dm-1", {
          authorId: "dm-user-1",
          context: { kind: "dm" },
        }),
      );
      await vi.waitFor(() => {
        expect(runtime.startTurn).toHaveBeenCalledTimes(2);
      });
      runtime.completeTurn("turn-2", createCompletedTurnResult());
      await dmFirst;

      now = 500;
      await vi.advanceTimersByTimeAsync(500);

      const channelSecond = service.generateReply(createAiInput("m3", "c2", "channel-2"));
      await vi.waitFor(() => {
        expect(runtime.startTurn).toHaveBeenCalledTimes(3);
      });
      runtime.completeTurn("turn-3", createCompletedTurnResult());
      await channelSecond;

      now = 1_000;
      await vi.advanceTimersByTimeAsync(500);

      const dmSecond = service.generateReply(
        createAiInput("m4", "dm-channel-2", "dm-2", {
          authorId: "dm-user-1",
          context: { kind: "dm" },
        }),
      );
      await vi.waitFor(() => {
        expect(runtime.startTurn).toHaveBeenCalledTimes(4);
      });
      runtime.completeTurn("turn-4", createCompletedTurnResult());
      await dmSecond;

      const channelThird = service.generateReply(createAiInput("m5", "c3", "channel-3"));
      await vi.waitFor(() => {
        expect(runtime.startTurn).toHaveBeenCalledTimes(5);
      });
      runtime.completeTurn("turn-5", createCompletedTurnResult());
      await channelThird;

      expect(runtime.startThread).toHaveBeenCalledTimes(3);
      expect(runtime.startTurn).toHaveBeenNthCalledWith(
        4,
        "thread-3",
        expect.any(String),
        expect.any(Object),
        { timeoutMs: 10 * 60_000 },
      );
      expect(runtime.startTurn).toHaveBeenNthCalledWith(
        5,
        "thread-1",
        expect.any(String),
        expect.any(Object),
        { timeoutMs: 10 * 60_000 },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("1時間アイドルでセッションを閉じる", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const runtime = new FakeAiRuntime();
      const service = createService({
        createRuntime: vi.fn(() => runtime),
        now: () => now,
        sessionIdleMs: 1_000,
      });

      const firstPromise = service.generateReply(createAiInput("m1", "c1", "first"));
      await vi.waitFor(() => {
        expect(runtime.startTurn).toHaveBeenCalledTimes(1);
      });
      runtime.completeTurn("turn-1", createCompletedTurnResult());
      await firstPromise;

      now = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);

      const secondPromise = service.generateReply(createAiInput("m2", "c1", "second"));
      await vi.waitFor(() => {
        expect(runtime.startThread).toHaveBeenCalledTimes(2);
      });
      runtime.completeTurn("turn-2", createCompletedTurnResult());
      await secondPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("アイドル期限到達時にturn進行中なら完了後に閉じる", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const runtime = new FakeAiRuntime();
      const service = createService({
        createRuntime: vi.fn(() => runtime),
        now: () => now,
        sessionIdleMs: 1_000,
      });

      const firstPromise = service.generateReply(createAiInput("m1", "c1", "first"));
      await vi.waitFor(() => {
        expect(runtime.startTurn).toHaveBeenCalledTimes(1);
      });

      now = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);

      runtime.completeTurn("turn-1", createCompletedTurnResult());
      await firstPromise;

      const secondPromise = service.generateReply(createAiInput("m2", "c1", "second"));
      await vi.waitFor(() => {
        expect(runtime.startThread).toHaveBeenCalledTimes(2);
      });
      runtime.completeTurn("turn-2", createCompletedTurnResult());
      await secondPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("steer 失敗時は interrupt 後に turn/start へフォールバックする", async () => {
    const runtime = new FakeAiRuntime();
    runtime.steerTurn.mockRejectedValueOnce(new Error("expected turn mismatch"));
    const service = createService({
      createRuntime: vi.fn(() => runtime),
    });

    const firstPromise = service.generateReply(createAiInput("m1", "c1", "first"));
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    });

    const secondPromise = service.generateReply(createAiInput("m2", "c1", "second"));
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    });

    expect(runtime.interruptTurn).toHaveBeenCalledTimes(1);
    expect(runtime.interruptTurn).toHaveBeenCalledWith("thread-1", "turn-1");

    runtime.completeTurn("turn-1", createCompletedTurnResult());
    runtime.completeTurn("turn-2", createCompletedTurnResult());
    await firstPromise;
    await secondPromise;
  });

  it("heartbeat は共有runtimeを使いながら専用threadで実行する", async () => {
    const runtime = new FakeAiRuntime();
    const createRuntime = vi.fn(() => runtime);
    const service = createService({
      createRuntime,
    });

    const runPromise = service.generateHeartbeat({
      prompt: "HEARTBEAT.mdを確認し、作業を行ってください。",
    });
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    });

    runtime.completeTurn("turn-1", createCompletedTurnResult());
    await runPromise;

    const replyPromise = service.generateReply(createAiInput("m1", "c1", "hello"));
    await vi.waitFor(() => {
      expect(runtime.startThread).toHaveBeenCalledTimes(2);
      expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    });

    runtime.completeTurn("turn-2", createCompletedTurnResult());
    await replyPromise;

    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.initialize).toHaveBeenCalledTimes(1);
    expect(runtime.startThread).toHaveBeenNthCalledWith(1, {
      config: buildThreadConfig("http://127.0.0.1:43123/mcp", "/tmp/workspace", "/tmp/codex"),
      developerRolePrompt: expect.any(String),
      instructions: expect.any(String),
    });
    expect(runtime.startThread).toHaveBeenNthCalledWith(2, {
      config: buildThreadConfig("http://127.0.0.1:43123/mcp", "/tmp/workspace", "/tmp/codex"),
      developerRolePrompt: expect.any(String),
      instructions: expect.any(String),
    });
    expect(runtime.startTurn).toHaveBeenNthCalledWith(
      1,
      "thread-1",
      "HEARTBEAT.mdを確認し、作業を行ってください。",
      expect.any(Object),
      { timeoutMs: 30 * 60_000 },
    );
  });

  it("close で runtime をクローズする", async () => {
    const runtime = new FakeAiRuntime();
    const service = createService({
      createRuntime: vi.fn(() => runtime),
    });

    await service.initializeRuntime();
    await service.close();

    expect(runtime.close).toHaveBeenCalledTimes(1);
  });
});

describe("buildThreadConfig", () => {
  it("uses HTTP MCP server url in thread config", () => {
    const config = buildThreadConfig("http://127.0.0.1:43123/mcp", "/tmp/workspace", "/tmp/codex");

    expect(config).toEqual({
      mcp_servers: {
        discord: {
          url: "http://127.0.0.1:43123/mcp",
        },
      },
      projects: {
        "/tmp/workspace": {
          trust_level: "trusted",
        },
      },
      skills: {
        config: [
          {
            enabled: false,
            path: "/tmp/codex/skills/.system/skill-creator/SKILL.md",
          },
          {
            enabled: false,
            path: "/tmp/codex/skills/.system/skill-installer/SKILL.md",
          },
        ],
      },
    });
  });

  it("workspace/codex path is resolved to absolute path in thread config", () => {
    const config = buildThreadConfig("http://127.0.0.1:43123/mcp", "../workspace", "../codex");

    expect(config).toEqual({
      mcp_servers: {
        discord: {
          url: "http://127.0.0.1:43123/mcp",
        },
      },
      projects: {
        [resolve("../workspace")]: {
          trust_level: "trusted",
        },
      },
      skills: {
        config: [
          {
            enabled: false,
            path: resolve("../codex/skills/.system/skill-creator/SKILL.md"),
          },
          {
            enabled: false,
            path: resolve("../codex/skills/.system/skill-installer/SKILL.md"),
          },
        ],
      },
    });
  });
});

class FakeAiRuntime {
  readonly initialize = vi.fn(async () => undefined);
  readonly startThread: ReturnType<typeof vi.fn>;
  readonly startTurn: ReturnType<typeof vi.fn>;
  readonly steerTurn = vi.fn(
    async (_threadId: string, _expectedTurnId: string, _prompt: string) => undefined,
  );
  readonly interruptTurn = vi.fn(async (_threadId: string, _turnId: string) => undefined);
  readonly close = vi.fn(async () => undefined);

  private readonly turns = new Map<string, Deferred<TurnResult>>();
  private nextTurnIndex = 1;
  private nextThreadIndex = 1;

  constructor() {
    this.startThread = vi.fn(async () => {
      const threadId = `thread-${this.nextThreadIndex}`;
      this.nextThreadIndex += 1;
      return threadId;
    });

    this.startTurn = vi.fn(
      async (
        _threadId: string,
        _prompt: string,
        _observer: TurnObserver | undefined,
        _options: { timeoutMs: number },
      ) => {
        const turnId = `turn-${this.nextTurnIndex++}`;
        const deferred = createDeferred<TurnResult>();
        this.turns.set(turnId, deferred);

        const startedTurn: StartedTurn = {
          completion: deferred.promise,
          turnId,
        };
        return startedTurn;
      },
    );
  }

  completeTurn(turnId: string, result: TurnResult): void {
    const deferred = this.turns.get(turnId);
    if (!deferred) {
      throw new Error(`Unknown turnId: ${turnId}`);
    }
    deferred.resolve(result);
  }
}

type CreateServiceInput = {
  createRuntime: () => FakeAiRuntime;
  onDiscordTurnCompleted?: (channelId: string) => void | Promise<void>;
  sessionIdleMs?: number;
  now?: () => number;
};

function createService(input: CreateServiceInput): ChannelSessionCoordinator {
  return new ChannelSessionCoordinator({
    createRuntime: () => input.createRuntime() as unknown as AiRuntimePort,
    discordMcpServerUrl: "http://127.0.0.1:43123/mcp",
    discordTurnTimeoutMs: 10 * 60_000,
    heartbeatTurnTimeoutMs: 30 * 60_000,
    codexHomeDir: "/tmp/codex",
    workspaceDir: "/tmp/workspace",
    ...(input.sessionIdleMs === undefined ? {} : { sessionIdleMs: input.sessionIdleMs }),
    ...(input.now ? { now: input.now } : {}),
    ...(input.onDiscordTurnCompleted
      ? { onDiscordTurnCompleted: input.onDiscordTurnCompleted }
      : {}),
  });
}

function createAiInput(
  messageId: string,
  channelId: string,
  content: string,
  options: {
    replyTo?: RuntimeMessage["replyTo"];
    loadRecentMessages?: () => Promise<RuntimeMessage[]>;
    context?: DiscordPromptContext;
    authorId?: string;
  } = {},
): {
  context: DiscordPromptContext;
  currentMessage: RuntimeMessage;
  loadRecentMessages: () => Promise<RuntimeMessage[]>;
} {
  const currentMessage: RuntimeMessage = {
    authorId: options.authorId ?? "author-id",
    authorIsBot: false,
    authorName: "author",
    channelId,
    content,
    createdAt: "2026-01-01 09:00:00 JST",
    id: messageId,
    mentionedBot: false,
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
  };

  return {
    context: options.context ?? {
      kind: "channel",
      channelName: `channel-${channelId}`,
    },
    currentMessage,
    loadRecentMessages:
      options.loadRecentMessages ??
      (async () => {
        return [];
      }),
  };
}

function createCompletedTurnResult(): TurnResult {
  return {
    assistantText: "ok",
    mcpToolCalls: [],
    status: "completed",
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = () => undefined;
  let rejectValue: (error: unknown) => void = () => undefined;

  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });

  return {
    promise,
    reject: rejectValue,
    resolve: resolveValue,
  };
}
