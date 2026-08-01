import { describe, expect, it, vi } from "vitest";

import type { AgentRuntimePort } from "../../../ports/outbound/agent-runtime-port";

import { AgentRuntimeRestartLimitError, AgentRuntimeSupervisor } from "./agent-runtime-supervisor";
import type { ManagedAgentRuntime } from "./managed-codex-runtime";

function createPort(): AgentRuntimePort {
  return {
    archiveThread: async () => undefined,
    deleteThread: async () => undefined,
    interruptTurn: async () => undefined,
    listThreads: async () => ({ data: [] }),
    openThread: async () => "thread-1",
    startTurn: async () => {
      throw new Error("unused");
    },
    steerTurn: async () => undefined,
  };
}

function createManagedRuntime(port = createPort()): ManagedAgentRuntime {
  return {
    close: async () => undefined,
    onFailure: () => () => undefined,
    port,
  };
}

describe("AgentRuntimeSupervisor", () => {
  it("初期化失敗を指数バックオフして再試行する", async () => {
    const delays: number[] = [];
    const startRuntime = vi
      .fn<() => Promise<ManagedAgentRuntime>>()
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockRejectedValueOnce(new Error("initialize failed"))
      .mockResolvedValue(createManagedRuntime());
    const supervisor = new AgentRuntimeSupervisor(
      { initialDelayMs: 1_000, limit: 5, maxDelayMs: 30_000, windowMs: 300_000 },
      {
        delay: async (milliseconds) => {
          delays.push(milliseconds);
        },
        now: () => 10_000,
        startRuntime,
      },
    );

    await supervisor.start();

    expect(startRuntime).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1_000, 2_000]);
  });

  it("window 内で上限を超えた次の障害を fatal にする", async () => {
    const startRuntime = vi
      .fn<() => Promise<ManagedAgentRuntime>>()
      .mockRejectedValue(new Error("always fails"));
    const supervisor = new AgentRuntimeSupervisor(
      { initialDelayMs: 100, limit: 2, maxDelayMs: 1_000, windowMs: 10_000 },
      { delay: async () => undefined, now: () => 1_000, startRuntime },
    );

    await expect(supervisor.start()).rejects.toBeInstanceOf(AgentRuntimeRestartLimitError);
    expect(startRuntime).toHaveBeenCalledTimes(3);
  });

  it("生成直後に既に壊れている runtime を READY として採用しない", async () => {
    const failedRuntime: ManagedAgentRuntime = {
      close: async () => undefined,
      onFailure: (handler) => {
        handler(new Error("already failed"));
        return () => undefined;
      },
      port: createPort(),
    };
    const startRuntime = vi
      .fn<() => Promise<ManagedAgentRuntime>>()
      .mockResolvedValueOnce(failedRuntime)
      .mockResolvedValueOnce(createManagedRuntime());
    const supervisor = new AgentRuntimeSupervisor(
      { initialDelayMs: 100, limit: 2, maxDelayMs: 1_000, windowMs: 10_000 },
      { delay: async () => undefined, now: () => 1_000, startRuntime },
    );

    await supervisor.start();

    expect(startRuntime).toHaveBeenCalledTimes(2);
  });

  it("各 restart entry を onFailure で通知し、initial delay 0 を許容する", async () => {
    const failure = new Error("spawn failed");
    const startRuntime = vi
      .fn<() => Promise<ManagedAgentRuntime>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(createManagedRuntime());
    const supervisor = new AgentRuntimeSupervisor(
      { initialDelayMs: 0, limit: 2, maxDelayMs: 1_000, windowMs: 10_000 },
      { delay: async () => undefined, now: () => 1_000, startRuntime },
    );
    const failures: Error[] = [];
    supervisor.onFailure((error) => failures.push(error));

    await supervisor.start();

    expect(failures).toEqual([failure]);
  });

  it("READY 世代の connection failure も onFailure で通知する", async () => {
    let reportFailure: ((error: Error) => void) | undefined;
    const firstRuntime: ManagedAgentRuntime = {
      close: async () => undefined,
      onFailure: (handler) => {
        reportFailure = handler;
        return () => undefined;
      },
      port: createPort(),
    };
    const startRuntime = vi
      .fn<() => Promise<ManagedAgentRuntime>>()
      .mockResolvedValueOnce(firstRuntime)
      .mockResolvedValueOnce(createManagedRuntime());
    const supervisor = new AgentRuntimeSupervisor(
      { initialDelayMs: 0, limit: 2, maxDelayMs: 1_000, windowMs: 10_000 },
      { delay: async () => undefined, now: () => 1_000, startRuntime },
    );
    const failures: Error[] = [];
    supervisor.onFailure((error) => failures.push(error));
    await supervisor.start();
    const failure = new Error("connection lost");

    if (reportFailure === undefined) {
      throw new Error("Failure handler was not registered.");
    }
    reportFailure(failure);
    await vi.waitFor(() => expect(startRuntime).toHaveBeenCalledTimes(2));

    expect(failures).toEqual([failure]);
  });

  it("旧runtimeのclose完了後にreplacementを起動する", async () => {
    let reportFailure: ((error: Error) => void) | undefined;
    const closing = deferred<void>();
    const firstRuntime: ManagedAgentRuntime = {
      close: async () => await closing.promise,
      onFailure: (handler) => {
        reportFailure = handler;
        return () => undefined;
      },
      port: createPort(),
    };
    const startRuntime = vi
      .fn<() => Promise<ManagedAgentRuntime>>()
      .mockResolvedValueOnce(firstRuntime)
      .mockResolvedValueOnce(createManagedRuntime());
    const supervisor = new AgentRuntimeSupervisor(
      { initialDelayMs: 0, limit: 2, maxDelayMs: 1_000, windowMs: 10_000 },
      { delay: async () => undefined, now: () => 1_000, startRuntime },
    );
    await supervisor.start();

    if (reportFailure === undefined) throw new Error("Failure handler was not registered.");
    reportFailure(new Error("connection lost"));
    await Promise.resolve();
    expect(startRuntime).toHaveBeenCalledOnce();

    closing.resolve();
    await vi.waitFor(() => expect(startRuntime).toHaveBeenCalledTimes(2));
  });

  it("close時に初期化中runtimeへabort signalを渡して待機を終える", async () => {
    const started = deferred<void>();
    const startRuntime = vi.fn(async (signal: AbortSignal): Promise<ManagedAgentRuntime> => {
      started.resolve(undefined);
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("startup aborted")), {
          once: true,
        });
      });
      return createManagedRuntime();
    });
    const supervisor = new AgentRuntimeSupervisor(
      { initialDelayMs: 0, limit: 2, maxDelayMs: 1_000, windowMs: 10_000 },
      { delay: async () => undefined, now: () => 1_000, startRuntime },
    );
    const startup = supervisor.start();
    await started.promise;

    await supervisor.close();

    await expect(startup).rejects.toThrow("closed");
    expect(startRuntime.mock.calls[0]?.[0].aborted).toBe(true);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("deferred is not initialized");
      resolvePromise(value);
    },
  };
}
