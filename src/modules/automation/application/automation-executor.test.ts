import { describe, expect, it, type Mock, vi } from "vitest";

import type { AutomationAgentPort } from "../ports/automation-agent-port";
import type { AutomationLogPort } from "../ports/automation-log-port";

import { AutomationExecutor } from "./automation-executor";

describe("AutomationExecutor", () => {
  it("turn/start応答後にhookを呼び、完了後にthreadをarchiveする", async () => {
    const completion = createDeferred<void>();
    const calls: string[] = [];
    const agent = createAgent({
      archiveThread: vi.fn(async () => {
        calls.push("archive");
      }),
      openAutomationThread: vi.fn(async () => {
        calls.push("open");
        return "thread-1";
      }),
      startAutomationTurn: vi.fn(async () => {
        calls.push("start");
        return { completion: completion.promise };
      }),
    });
    const executor = new AutomationExecutor({ agent, logger: createLogger() });

    const execution = executor.execute(
      { jobId: "job-1", prompt: "prompt", source: "schedule" },
      async () => {
        calls.push("hook");
      },
    );
    await vi.waitFor(() => {
      expect(calls).toEqual(["open", "start", "hook"]);
    });

    completion.resolve();
    await expect(execution).resolves.toEqual({ status: "completed" });
    expect(calls).toEqual(["open", "start", "hook", "archive"]);
  });

  it("turn失敗を記録し、作成済みthreadをarchiveする", async () => {
    const logger = createLogger();
    const agent = createAgent({
      startAutomationTurn: vi.fn(async () => {
        throw new Error("turn failed");
      }),
    });
    const executor = new AutomationExecutor({ agent, logger });

    const result = await executor.execute({ checklist: "check", source: "heartbeat" });

    expect(result.status).toBe("failed");
    expect(agent.archiveThread).toHaveBeenCalledWith("thread-1");
    expect(logger.error).toHaveBeenCalledWith(
      "automation.execution.failed",
      expect.objectContaining({ source: "heartbeat", threadId: "thread-1" }),
    );
  });

  it("thread作成失敗時はarchiveせず、archive失敗は実行結果を変更しない", async () => {
    const logger = createLogger();
    const openFailure = createAgent({
      openAutomationThread: vi.fn(async () => {
        throw new Error("open failed");
      }),
    });
    const failedExecutor = new AutomationExecutor({ agent: openFailure, logger });

    await expect(
      failedExecutor.execute({ checklist: "check", source: "heartbeat" }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(openFailure.archiveThread).not.toHaveBeenCalled();

    const archiveFailure = createAgent({
      archiveThread: vi.fn(async () => {
        throw new Error("archive failed");
      }),
    });
    const completedExecutor = new AutomationExecutor({ agent: archiveFailure, logger });
    await expect(
      completedExecutor.execute({ checklist: "check", source: "heartbeat" }),
    ).resolves.toEqual({ status: "completed" });
    expect(logger.error).toHaveBeenCalledWith(
      "automation.thread.archive_failed",
      expect.objectContaining({ threadId: "thread-1" }),
    );
  });
});

type AgentStub = {
  [Key in keyof AutomationAgentPort]: Mock<AutomationAgentPort[Key]>;
};

function createAgent(overrides: Partial<AutomationAgentPort> = {}): AgentStub {
  return {
    archiveThread: vi.fn(overrides.archiveThread ?? (async () => undefined)),
    deleteArchivedThread: vi.fn(overrides.deleteArchivedThread ?? (async () => undefined)),
    listArchivedThreads: vi.fn(overrides.listArchivedThreads ?? (async () => ({ data: [] }))),
    openAutomationThread: vi.fn(overrides.openAutomationThread ?? (async () => "thread-1")),
    startAutomationTurn: vi.fn(
      overrides.startAutomationTurn ?? (async () => ({ completion: Promise.resolve() })),
    ),
  };
}

type LoggerStub = {
  [Key in keyof AutomationLogPort]: Mock<AutomationLogPort[Key]>;
};

function createLogger(): LoggerStub {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createDeferred<Value>(): {
  promise: Promise<Value>;
  resolve: (value: Value | PromiseLike<Value>) => void;
} {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
