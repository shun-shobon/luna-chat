import { describe, expect, it, vi } from "vitest";

import type { RuntimeMessage } from "../context/types";

import {
  buildThreadConfig,
  CodexAppServerAiService,
  type AiInput,
  type CodexAppServerAiServiceOptions,
} from "./ai-service";
import type { StartedTurn, TurnResult } from "./codex-app-server-client";

describe("CodexAppServerAiService", () => {
  it("同一チャンネルで進行中turnがある場合は steer を送る", async () => {
    const client = new FakeCodexClient();
    const service = createService({
      buildPromptBundle: vi.fn(async () => {
        return createPromptBundle("初回プロンプト");
      }),
      createClient: vi.fn(() => client),
    });

    const firstPromise = service.generateReply(createAiInput("m1", "c1", "first"));
    await vi.waitFor(() => {
      expect(client.startTurn).toHaveBeenCalledTimes(1);
    });

    await service.generateReply(createAiInput("m2", "c1", "second"));

    expect(client.steerTurn).toHaveBeenCalledTimes(1);
    expect(client.steerTurn).toHaveBeenCalledWith(
      "thread-1",
      "turn-1",
      expect.stringContaining("second"),
    );

    client.completeTurn("turn-1", createCompletedTurnResult());
    await firstPromise;
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("起動中に到着した後続メッセージも同一セッションに合流する", async () => {
    const initializeGate = createDeferred<void>();
    const client = new FakeCodexClient({
      initializeGate,
    });
    const service = createService({
      buildPromptBundle: vi.fn(async () => {
        return createPromptBundle("初回プロンプト");
      }),
      createClient: vi.fn(() => client),
    });

    const firstPromise = service.generateReply(createAiInput("m1", "c1", "first"));
    const secondPromise = service.generateReply(createAiInput("m2", "c1", "second"));

    expect(client.startTurn).toHaveBeenCalledTimes(0);
    expect(client.steerTurn).toHaveBeenCalledTimes(0);

    initializeGate.resolve();

    await vi.waitFor(() => {
      expect(client.startTurn).toHaveBeenCalledTimes(1);
    });
    await secondPromise;

    expect(client.steerTurn).toHaveBeenCalledTimes(1);
    expect(client.steerTurn).toHaveBeenCalledWith(
      "thread-1",
      "turn-1",
      expect.stringContaining("second"),
    );

    client.completeTurn("turn-1", createCompletedTurnResult());
    await firstPromise;
  });

  it("steer 失敗時は同一threadで turn/start にフォールバックする", async () => {
    const client = new FakeCodexClient();
    client.steerTurn.mockRejectedValueOnce(new Error("expected turn mismatch"));
    const service = createService({
      buildPromptBundle: vi.fn(async () => {
        return createPromptBundle("初回プロンプト");
      }),
      createClient: vi.fn(() => client),
    });

    const firstPromise = service.generateReply(createAiInput("m1", "c1", "first"));
    await vi.waitFor(() => {
      expect(client.startTurn).toHaveBeenCalledTimes(1);
    });

    await service.generateReply(createAiInput("m2", "c1", "second"));

    expect(client.steerTurn).toHaveBeenCalledTimes(1);
    expect(client.startTurn).toHaveBeenCalledTimes(2);
    expect(client.startTurn).toHaveBeenNthCalledWith(
      2,
      "thread-1",
      expect.stringContaining("追加メッセージ"),
    );

    client.completeTurn("turn-1", createCompletedTurnResult());
    await firstPromise;

    client.completeTurn("turn-2", createCompletedTurnResult());
    await vi.waitFor(() => {
      expect(client.close).toHaveBeenCalledTimes(1);
    });
  });

  it("turn完了後はセッションを閉じ、次メッセージで新規起動する", async () => {
    const client1 = new FakeCodexClient();
    const client2 = new FakeCodexClient();
    const createClient = vi
      .fn<() => FakeCodexClient>()
      .mockReturnValueOnce(client1)
      .mockReturnValueOnce(client2);
    const service = createService({
      buildPromptBundle: vi.fn(async () => {
        return createPromptBundle("初回プロンプト");
      }),
      createClient,
    });

    const firstPromise = service.generateReply(createAiInput("m1", "c1", "first"));
    await vi.waitFor(() => {
      expect(client1.startTurn).toHaveBeenCalledTimes(1);
    });
    client1.completeTurn("turn-1", createCompletedTurnResult());
    await firstPromise;

    const secondPromise = service.generateReply(createAiInput("m2", "c1", "second"));
    await vi.waitFor(() => {
      expect(client2.startTurn).toHaveBeenCalledTimes(1);
    });

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(client1.steerTurn).toHaveBeenCalledTimes(0);

    client2.completeTurn("turn-1", createCompletedTurnResult());
    await secondPromise;
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

type FakeCodexClientOptions = {
  initializeGate?: Deferred<void>;
};

class FakeCodexClient {
  readonly initialize;
  readonly startThread;
  readonly startTurn;
  readonly steerTurn;
  readonly close;

  private readonly turns = new Map<string, Deferred<TurnResult>>();
  private nextTurnIndex = 1;

  constructor(private readonly options: FakeCodexClientOptions = {}) {
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
  buildPromptBundle: (
    input: AiInput,
    cwd: string,
  ) => Promise<{
    developerRolePrompt: string;
    instructions: string;
    userRolePrompt: string;
  }>;
  createClient: () => FakeCodexClient;
};

function createService(input: CreateServiceInput): CodexAppServerAiService {
  return new CodexAppServerAiService(createOptions(), {
    buildPromptBundle: input.buildPromptBundle,
    createClient: () => input.createClient(),
  });
}

function createOptions(): CodexAppServerAiServiceOptions {
  return {
    approvalPolicy: "never",
    codexHomeDir: "/tmp/codex",
    command: "codex app-server --listen stdio://",
    cwd: "/tmp/workspace",
    discordMcpServerUrl: "http://127.0.0.1:43123/mcp",
    model: "gpt-5.3-codex",
    reasoningEffort: "medium",
    sandbox: "workspace-write",
    timeoutMs: 60_000,
  };
}

function createPromptBundle(userRolePrompt: string): {
  developerRolePrompt: string;
  instructions: string;
  userRolePrompt: string;
} {
  return {
    developerRolePrompt: "developer",
    instructions: "instructions",
    userRolePrompt,
  };
}

function createAiInput(messageId: string, channelId: string, content: string): AiInput {
  const currentMessage: RuntimeMessage = {
    authorId: "author-id",
    authorName: "author",
    channelId,
    content,
    createdAt: "2026-01-01 09:00:00 JST",
    id: messageId,
    mentionedBot: false,
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
