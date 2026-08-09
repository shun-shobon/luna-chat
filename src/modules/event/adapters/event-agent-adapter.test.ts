import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type {
  AgentRuntimePort,
  AgentThreadInput,
  AgentTurnResult,
} from "../../agent/ports/outbound/agent-runtime-port";
import { createEffectOutputContract } from "../../effect/application/effect-output-contract";
import { createEffectRegistry } from "../../effect/application/effect-registry";
import { createEffectBatchExecutor } from "../../effect/application/execute-effect-batch";
import type { EffectProvider } from "../../effect/ports/effect-provider";
import { defineEffect } from "../../effect/ports/effect-provider";
import type { LoggerPort } from "../../observability/ports/logger-port";
import { EventExecutor } from "../application/event-executor";
import type { LunaEvent } from "../domain/luna-event";

import { EventAgentAdapter } from "./event-agent-adapter";

const event: LunaEvent = {
  id: "sensor-event-1",
  type: "test.sensor.changed.v1",
  source: "test/sensor",
  subject: "sensor.temperature",
  occurredAt: "2026-08-09T03:00:00Z",
  data: { from: 23, to: 24 },
};

const threadInput: AgentThreadInput = {
  executionOwnerId: "owner-1",
  baseInstructions: "Luna",
  config: {},
  cwd: "/workspace",
  developerInstructions: "protocol",
};

const recordInputSchema = z.strictObject({ target: z.string(), value: z.string() });

describe("EventAgentAdapter", () => {
  it("非Discord Eventをthread openからfake Effect実行、archiveまで処理する", async () => {
    const calls: string[] = [];
    const execute = vi.fn(async (input: z.infer<typeof recordInputSchema>, ownerId: string) => {
      calls.push("effect");
      return { ownerId, recorded: input.value };
    });
    const release = vi.fn(async () => {
      calls.push("release");
    });
    const provider = createRecordProvider({ execute, release });
    const registry = createEffectRegistry([provider]);
    const output = createEffectOutputContract(registry);
    const { port: logger } = createLogger();
    const effects = createEffectBatchExecutor(registry, logger);
    const { agent, archiveThread, openThread, startTurn } = createAgent(
      [
        completed({
          effects: [
            { type: "fake.record", input: { target: "audit", value: "temperature changed" } },
          ],
        }),
      ],
      calls,
    );
    const adapter = new EventAgentAdapter({
      agent,
      createThreadInput: async () => threadInput,
      effectOutput: output,
      effects,
      onError: vi.fn(),
    });
    const executor = new EventExecutor({ agent: adapter, logger });

    await expect(executor.execute(event)).resolves.toEqual({ status: "completed" });

    expect(openThread).toHaveBeenCalledWith(threadInput);
    expect(startTurn).toHaveBeenCalledWith("thread-1", {
      input: JSON.stringify({ source: "event", event }),
      outputSchema: output.jsonSchema,
    });
    expect(execute).toHaveBeenCalledWith(
      { target: "audit", value: "temperature changed" },
      "owner-1",
    );
    expect(archiveThread).toHaveBeenCalledWith("thread-1");
    expect(calls[0]).toBe("open");
    expect(calls.at(-1)).toBe("archive");
  });

  it("Effect失敗結果を同じthreadへfollow-upし、成功後にarchiveする", async () => {
    const execute = vi
      .fn(async (input: z.infer<typeof recordInputSchema>) => input)
      .mockRejectedValueOnce(new Error("record failed"));
    const provider = createRecordProvider({ execute });
    const registry = createEffectRegistry([provider]);
    const output = createEffectOutputContract(registry);
    const { port: logger } = createLogger();
    const effects = createEffectBatchExecutor(registry, logger);
    const { agent, archiveThread, startTurn } = createAgent([
      completed({
        effects: [{ type: "fake.record", input: { target: "audit", value: "first" } }],
      }),
      completed({ effects: [] }),
    ]);
    const adapter = new EventAgentAdapter({
      agent,
      createThreadInput: async () => threadInput,
      effectOutput: output,
      effects,
      onError: vi.fn(),
    });
    const executor = new EventExecutor({ agent: adapter, logger });

    await expect(executor.execute(event)).resolves.toEqual({ status: "completed" });

    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(startTurn.mock.calls[1]?.[0]).toBe("thread-1");
    expect(JSON.parse(startTurn.mock.calls[1]?.[1].input ?? "null")).toEqual({
      source: "effect_results",
      results: [
        {
          index: 0,
          type: "fake.record",
          target: "audit",
          success: false,
          error: "record failed",
        },
      ],
    });
    expect(archiveThread).toHaveBeenCalledWith("thread-1");
  });

  it("Effect output parse失敗時もthreadをarchiveする", async () => {
    const harness = createHarness([{ status: "completed", outputText: "{" }]);

    const result = await harness.executor.execute(event);

    expect(result.status).toBe("failed");
    expect(harness.archiveThread).toHaveBeenCalledWith("thread-1");
    expect(harness.executeEffect).not.toHaveBeenCalled();
  });

  it.each<AgentTurnResult>([
    { status: "failed", errorMessage: "turn failed" },
    { status: "interrupted" },
  ])("turnが$statusでもthreadをarchiveする", async (turn) => {
    const harness = createHarness([turn]);

    const result = await harness.executor.execute(event);

    expect(result.status).toBe("failed");
    expect(harness.archiveThread).toHaveBeenCalledWith("thread-1");
    expect(harness.executeEffect).not.toHaveBeenCalled();
  });

  it("Effect実行中のconnection lossでowner resourceをreleaseし、旧threadへfollow-upしない", async () => {
    const effectCompletion = createDeferred<{ recorded: string }>();
    const execute = vi.fn(async () => await effectCompletion.promise);
    const release = vi.fn(async () => {});
    const provider = createRecordProvider({ execute, release });
    const registry = createEffectRegistry([provider]);
    const output = createEffectOutputContract(registry);
    const { port: logger } = createLogger();
    const effects = createEffectBatchExecutor(registry, logger);
    const { agent, startTurn } = createAgent([
      completed({
        effects: [{ type: "fake.record", input: { target: "audit", value: "first" } }],
      }),
    ]);
    const adapter = new EventAgentAdapter({
      agent,
      createThreadInput: async () => threadInput,
      effectOutput: output,
      effects,
      onError: vi.fn(),
    });
    const threadId = await adapter.openEventThread();
    const turn = await adapter.startEventTurn(threadId, event);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    adapter.connectionLost();
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith("owner-1"));
    effectCompletion.resolve({ recorded: "first" });

    await expect(turn.completion).rejects.toThrow("connection was lost");
    expect(startTurn).toHaveBeenCalledOnce();
  });
});

function createHarness(turns: readonly AgentTurnResult[]) {
  const executeEffect = vi.fn(async (input: z.infer<typeof recordInputSchema>) => input);
  const provider = createRecordProvider({ execute: executeEffect });
  const registry = createEffectRegistry([provider]);
  const output = createEffectOutputContract(registry);
  const { port: logger } = createLogger();
  const effects = createEffectBatchExecutor(registry, logger);
  const { agent, archiveThread } = createAgent(turns);
  const adapter = new EventAgentAdapter({
    agent,
    createThreadInput: async () => threadInput,
    effectOutput: output,
    effects,
    onError: vi.fn(),
  });
  return {
    archiveThread,
    executeEffect,
    executor: new EventExecutor({ agent: adapter, logger }),
  };
}

function createRecordProvider(
  overrides: Partial<{
    execute: (input: z.infer<typeof recordInputSchema>, ownerId: string) => Promise<unknown>;
    release: (ownerId: string) => Promise<void>;
  }> = {},
): EffectProvider {
  return {
    definitions: [
      defineEffect({
        type: "fake.record",
        agentInputSchema: recordInputSchema,
        inputSchema: recordInputSchema,
        parseInput: (input) => input,
        execute: async (input, ownerId) =>
          z.json().parse(await (overrides.execute ?? (async (value) => value))(input, ownerId)),
        describeTarget: (input) => input.target,
      }),
    ],
    release: overrides.release ?? (async () => {}),
  };
}

function completed(output: unknown): AgentTurnResult {
  return { status: "completed", outputText: JSON.stringify(output) };
}

function createAgent(turns: readonly AgentTurnResult[], calls: string[] = []) {
  let index = 0;
  const openThread = vi.fn<AgentRuntimePort["openThread"]>(async () => {
    calls.push("open");
    return "thread-1";
  });
  const startTurn = vi.fn<AgentRuntimePort["startTurn"]>(async () => {
    const completion = turns[index];
    if (completion === undefined) throw new Error("No fake turn result remains.");
    index += 1;
    return { turnId: `turn-${String(index)}`, completion: Promise.resolve(completion) };
  });
  const archiveThread = vi.fn<AgentRuntimePort["archiveThread"]>(async () => {
    calls.push("archive");
  });
  const agent: AgentRuntimePort = {
    archiveThread,
    deleteThread: vi.fn(async () => {}),
    listThreads: vi.fn(async () => ({ data: [] })),
    openThread,
    interruptTurn: vi.fn(async () => {}),
    startTurn,
    steerTurn: vi.fn(async () => {}),
  };
  return { agent, archiveThread, openThread, startTurn };
}

function createLogger(): { port: LoggerPort; log: ReturnType<typeof vi.fn<LoggerPort["log"]>> } {
  const log = vi.fn<LoggerPort["log"]>();
  return { port: { log }, log };
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
