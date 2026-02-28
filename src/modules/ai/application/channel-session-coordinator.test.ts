import { describe, expect, it, vi } from "vitest";

import type { RuntimeMessage } from "../../conversation/domain/runtime-message";
import type { TurnResult } from "../adapters/outbound/codex/turn-result-collector";
import type { StartedTurn } from "../ports/outbound/ai-runtime-port";

import { ChannelSessionCoordinator } from "./channel-session-coordinator";
import { buildThreadConfig } from "./thread-config-factory";

describe("ChannelSessionCoordinator", () => {
  it("同一チャンネルで進行中turnがある場合は steer を送る", async () => {
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
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it("返信付きメッセージでも同一 turn へ steer する", async () => {
    const runtime = new FakeAiRuntime();
    const service = createService({
      createRuntime: vi.fn(() => runtime),
    });

    const firstPromise = service.generateReply(createAiInput("m1", "c1", "first"));
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    });

    await service.generateReply(
      createAiInput("m2", "c1", "second", {
        replyTo: {
          authorId: "reply-author-id",
          authorIsBot: false,
          authorName: "reply-author",
          content: "reply content",
          createdAt: "2026-01-01 08:59:00 JST",
          id: "reply-message-id",
        },
      }),
    );

    expect(runtime.steerTurn).toHaveBeenCalledTimes(1);
    expect(runtime.steerTurn).toHaveBeenCalledWith("thread-1", "turn-1", expect.any(String));

    runtime.completeTurn("turn-1", createCompletedTurnResult());
    await firstPromise;
  });

  it("起動中に到着した後続メッセージも同一セッションに合流する", async () => {
    const initializeGate = createDeferred<void>();
    const runtime = new FakeAiRuntime({
      initializeGate,
    });
    const service = createService({
      createRuntime: vi.fn(() => runtime),
    });

    const firstPromise = service.generateReply(createAiInput("m1", "c1", "first"));
    const secondPromise = service.generateReply(createAiInput("m2", "c1", "second"));

    expect(runtime.startTurn).toHaveBeenCalledTimes(0);
    expect(runtime.steerTurn).toHaveBeenCalledTimes(0);

    initializeGate.resolve();

    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    });
    await secondPromise;

    expect(runtime.steerTurn).toHaveBeenCalledTimes(1);
    expect(runtime.steerTurn).toHaveBeenCalledWith("thread-1", "turn-1", expect.any(String));

    runtime.completeTurn("turn-1", createCompletedTurnResult());
    await firstPromise;
  });

  it("steer 失敗時は同一threadで turn/start にフォールバックする", async () => {
    const runtime = new FakeAiRuntime();
    runtime.steerTurn.mockRejectedValueOnce(new Error("expected turn mismatch"));
    const service = createService({
      createRuntime: vi.fn(() => runtime),
    });

    const firstPromise = service.generateReply(createAiInput("m1", "c1", "first"));
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    });

    await service.generateReply(createAiInput("m2", "c1", "second"));

    expect(runtime.steerTurn).toHaveBeenCalledTimes(1);
    expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    expect(runtime.startTurn).toHaveBeenNthCalledWith(2, "thread-1", expect.any(String));

    runtime.completeTurn("turn-1", createCompletedTurnResult());
    await firstPromise;

    runtime.completeTurn("turn-2", createCompletedTurnResult());
    await vi.waitFor(() => {
      expect(runtime.close).toHaveBeenCalledTimes(1);
    });
  });

  it("turn完了後はセッションを閉じ、次メッセージで新規起動する", async () => {
    const runtime1 = new FakeAiRuntime();
    const runtime2 = new FakeAiRuntime();
    const createRuntime = vi
      .fn<() => FakeAiRuntime>()
      .mockReturnValueOnce(runtime1)
      .mockReturnValueOnce(runtime2);
    const service = createService({
      createRuntime,
    });

    const firstPromise = service.generateReply(createAiInput("m1", "c1", "first"));
    await vi.waitFor(() => {
      expect(runtime1.startTurn).toHaveBeenCalledTimes(1);
    });
    runtime1.completeTurn("turn-1", createCompletedTurnResult());
    await firstPromise;

    const secondPromise = service.generateReply(createAiInput("m2", "c1", "second"));
    await vi.waitFor(() => {
      expect(runtime2.startTurn).toHaveBeenCalledTimes(1);
    });

    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(runtime1.steerTurn).toHaveBeenCalledTimes(0);

    runtime2.completeTurn("turn-1", createCompletedTurnResult());
    await secondPromise;
  });

  it("heartbeat 実行時は専用プロンプトで turn を完了まで待機する", async () => {
    const runtime = new FakeAiRuntime();
    const service = createService({
      createRuntime: vi.fn(() => runtime),
    });

    const runPromise = service.generateHeartbeat({
      prompt: "HEARTBEAT.mdを確認し、作業を行ってください。",
    });
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    });

    expect(runtime.startTurn).toHaveBeenCalledWith(
      "thread-1",
      "HEARTBEAT.mdを確認し、作業を行ってください。",
    );

    runtime.completeTurn("turn-1", createCompletedTurnResult());
    await runPromise;
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it("heartbeat の turn が失敗した場合でも runtime を close する", async () => {
    const runtime = new FakeAiRuntime();
    const service = createService({
      createRuntime: vi.fn(() => runtime),
    });

    const runPromise = service.generateHeartbeat({
      prompt: "HEARTBEAT.mdを確認し、作業を行ってください。",
    });
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    });

    runtime.completeTurn("turn-1", createFailedTurnResult("heartbeat failed"));
    await expect(runPromise).rejects.toThrow("heartbeat failed");
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it("turn完了時に onDiscordTurnCompleted を呼び出す", async () => {
    const runtime = new FakeAiRuntime();
    const onDiscordTurnCompleted = vi.fn();
    const service = createService({
      createRuntime: vi.fn(() => runtime),
      onDiscordTurnCompleted,
    });

    const runPromise = service.generateReply(createAiInput("m1", "c1", "first"));
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    });

    runtime.completeTurn("turn-1", createCompletedTurnResult());
    await runPromise;

    expect(onDiscordTurnCompleted).toHaveBeenCalledTimes(1);
    expect(onDiscordTurnCompleted).toHaveBeenCalledWith("c1");
  });

  it("旧turn完了では onDiscordTurnCompleted を呼び出さない", async () => {
    const runtime = new FakeAiRuntime();
    runtime.steerTurn.mockRejectedValueOnce(new Error("expected turn mismatch"));
    const onDiscordTurnCompleted = vi.fn();
    const service = createService({
      createRuntime: vi.fn(() => runtime),
      onDiscordTurnCompleted,
    });

    const runPromise = service.generateReply(createAiInput("m1", "c1", "first"));
    await vi.waitFor(() => {
      expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    });

    await service.generateReply(createAiInput("m2", "c1", "second"));
    expect(runtime.startTurn).toHaveBeenCalledTimes(2);

    runtime.completeTurn("turn-1", createCompletedTurnResult());
    await vi.waitFor(() => {
      expect(onDiscordTurnCompleted).toHaveBeenCalledTimes(0);
    });

    runtime.completeTurn("turn-2", createCompletedTurnResult());
    await runPromise;
    expect(onDiscordTurnCompleted).toHaveBeenCalledTimes(1);
    expect(onDiscordTurnCompleted).toHaveBeenCalledWith("c1");
  });
});

describe("buildThreadConfig", () => {
  it("uses HTTP MCP server url in thread config", () => {
    const config = buildThreadConfig("medium", "http://127.0.0.1:43123/mcp");

    expect(config).toEqual({
      mcp_servers: {
        discord: {
          url: "http://127.0.0.1:43123/mcp",
        },
      },
      model_reasoning_effort: "medium",
    });
  });
});

type FakeAiRuntimeOptions = {
  initializeGate?: Deferred<void>;
};

class FakeAiRuntime {
  readonly initialize;
  readonly startThread;
  readonly startTurn;
  readonly steerTurn;
  readonly close;

  private readonly turns = new Map<string, Deferred<TurnResult>>();
  private nextTurnIndex = 1;

  constructor(private readonly options: FakeAiRuntimeOptions = {}) {
    this.initialize = vi.fn(async () => {
      if (this.options.initializeGate) {
        await this.options.initializeGate.promise;
      }
    });
    this.startThread = vi.fn(async () => {
      return "thread-1";
    });
    this.startTurn = vi.fn(async () => {
      const turnId = `turn-${this.nextTurnIndex++}`;
      const deferred = createDeferred<TurnResult>();
      this.turns.set(turnId, deferred);

      const startedTurn: StartedTurn = {
        completion: deferred.promise,
        turnId,
      };
      return startedTurn;
    });
    this.steerTurn = vi.fn(async () => undefined);
    this.close = vi.fn();
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
};

function createService(input: CreateServiceInput): ChannelSessionCoordinator {
  return new ChannelSessionCoordinator({
    createRuntime: () => input.createRuntime(),
    discordMcpServerUrl: "http://127.0.0.1:43123/mcp",
    reasoningEffort: "medium",
    workspaceDir: "/tmp/workspace",
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
  } = {},
): {
  channelName: string;
  currentMessage: RuntimeMessage;
  recentMessages: RuntimeMessage[];
} {
  const currentMessage: RuntimeMessage = {
    authorId: "author-id",
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
    channelName: "general",
    currentMessage,
    recentMessages: [],
  };
}

function createCompletedTurnResult(): TurnResult {
  return {
    assistantText: "ok",
    mcpToolCalls: [],
    status: "completed",
  };
}

function createFailedTurnResult(errorMessage: string): TurnResult {
  return {
    assistantText: "",
    errorMessage,
    mcpToolCalls: [],
    status: "failed",
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
