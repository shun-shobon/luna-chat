import { describe, expect, it } from "vitest";

import { CodexAgentRuntime } from "./codex-agent-runtime";
import type { CodexLineTransport } from "./codex-stdio-process";
import { JsonRpcConnection, JsonRpcProtocolError } from "./json-rpc-connection";

class FakeTransport implements CodexLineTransport {
  readonly writes: object[] = [];
  readonly #failureHandlers = new Set<(error: Error) => void>();
  readonly #lineHandlers = new Set<(line: string) => void>();

  public async close(): Promise<void> {}

  public emit(value: object): void {
    for (const handler of this.#lineHandlers) {
      handler(JSON.stringify(value));
    }
  }

  public onFailure(handler: (error: Error) => void): () => void {
    this.#failureHandlers.add(handler);
    return () => this.#failureHandlers.delete(handler);
  }

  public onLine(handler: (line: string) => void): () => void {
    this.#lineHandlers.add(handler);
    return () => this.#lineHandlers.delete(handler);
  }

  public writeLine(value: object): void {
    this.writes.push(value);
  }
}

async function initializeRuntime(transport: FakeTransport): Promise<CodexAgentRuntime> {
  const connection = new JsonRpcConnection(transport, 1_000);
  const initializing = CodexAgentRuntime.initialize(connection);
  transport.emit({
    id: 1,
    result: {
      codexHome: "/codex-home",
      platformFamily: "unix",
      platformOs: "macos",
      userAgent: "codex-test",
    },
  });
  return await initializing;
}

describe("CodexAgentRuntime", () => {
  it("生成型に存在する thread/delete を送信する", async () => {
    const transport = new FakeTransport();
    const runtime = await initializeRuntime(transport);

    const deletion = runtime.deleteThread("thread-1");
    transport.emit({ id: 2, result: {} });

    await expect(deletion).resolves.toBeUndefined();
    expect(transport.writes).toContainEqual({
      id: 2,
      method: "thread/delete",
      params: { threadId: "thread-1" },
    });
  });

  it("thread を永続化し、承認なしの danger-full-access で開始する", async () => {
    const transport = new FakeTransport();
    const runtime = await initializeRuntime(transport);

    const opening = runtime.openThread({
      baseInstructions: "base",
      config: { feature: true },
      cwd: "/workspace",
      developerInstructions: "developer",
    });
    transport.emit({ id: 2, result: { thread: { id: "thread-1" } } });

    await expect(opening).resolves.toBe("thread-1");
    expect(transport.writes).toContainEqual({
      id: 2,
      method: "thread/start",
      params: {
        approvalPolicy: "never",
        baseInstructions: "base",
        config: { feature: true },
        cwd: "/workspace",
        developerInstructions: "developer",
        ephemeral: false,
        sandbox: "danger-full-access",
      },
    });
  });

  it("turn/start response と通知を相関し、final output を返す", async () => {
    const transport = new FakeTransport();
    const runtime = await initializeRuntime(transport);

    const starting = runtime.startTurn("thread-1", "hello");
    transport.emit({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    transport.emit({ id: 2, result: { turn: { id: "turn-1" } } });
    const started = await starting;

    transport.emit({
      method: "item/completed",
      params: {
        item: { phase: "final_answer", text: '{"actions":[]}', type: "agentMessage" },
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    transport.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { error: null, id: "turn-1", status: "completed" },
      },
    });

    expect(started.turnId).toBe("turn-1");
    await expect(started.completion).resolves.toEqual({
      output: { actions: [] },
      status: "completed",
    });
  });

  it("turn/start response と先行通知の turn id 不一致を protocol fatal にする", async () => {
    const transport = new FakeTransport();
    const runtime = await initializeRuntime(transport);

    const starting = runtime.startTurn("thread-1", "hello");
    transport.emit({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-from-notification" } },
    });
    transport.emit({ id: 2, result: { turn: { id: "turn-from-response" } } });

    await expect(starting).rejects.toBeInstanceOf(JsonRpcProtocolError);
  });
});
