import { describe, expect, it } from "vitest";

import type { AgentTurnRequest } from "../../../ports/outbound/agent-runtime-port";

import { CodexAgentRuntime } from "./codex-agent-runtime";
import type { CodexLineTransport } from "./codex-stdio-process";
import { TurnNotSteerableError } from "./codex-turn-tracker";
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

function turnRequest(input: string): AgentTurnRequest {
  return {
    input,
    outputSchema: {
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
      type: "object",
    },
  };
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

    const request = turnRequest("hello");
    const starting = runtime.startTurn("thread-1", request);
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
    expect(transport.writes).toContainEqual({
      id: 2,
      method: "turn/start",
      params: {
        input: [{ text: "hello", text_elements: [], type: "text" }],
        outputSchema: request.outputSchema,
        threadId: "thread-1",
      },
    });
    await expect(started.completion).resolves.toEqual({
      outputText: '{"actions":[]}',
      status: "completed",
    });
  });

  it("caller supplied output schema が JSON value でなければ turn/start を送信しない", async () => {
    const transport = new FakeTransport();
    const runtime = await initializeRuntime(transport);

    await expect(
      runtime.startTurn("thread-1", {
        input: "hello",
        outputSchema: { type: "object", invalid: undefined },
      }),
    ).rejects.toThrow("agent output schema.invalid must not be undefined");
    expect(
      transport.writes.filter((write) => Reflect.get(write, "method") === "turn/start"),
    ).toHaveLength(0);
  });

  it("final_answer 受領後の steer を RPC 送信前に拒否し、先行outputを保持する", async () => {
    const transport = new FakeTransport();
    const runtime = await initializeRuntime(transport);

    const starting = runtime.startTurn("thread-1", turnRequest("first"));
    transport.emit({ id: 2, result: { turn: { id: "turn-1" } } });
    const started = await starting;
    transport.emit({
      method: "item/completed",
      params: {
        item: {
          phase: "final_answer",
          text: '{"actions":[{"kind":"send_message","target":{"kind":"channel","channelId":"123456789012345678"},"content":"first answer","files":null}]}',
          type: "agentMessage",
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });

    await expect(runtime.steerTurn("thread-1", "turn-1", "second")).rejects.toBeInstanceOf(
      TurnNotSteerableError,
    );
    expect(
      transport.writes.filter((write) => Reflect.get(write, "method") === "turn/steer"),
    ).toHaveLength(0);

    transport.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { error: null, id: "turn-1", status: "completed" },
      },
    });
    await expect(started.completion).resolves.toEqual({
      outputText:
        '{"actions":[{"kind":"send_message","target":{"kind":"channel","channelId":"123456789012345678"},"content":"first answer","files":null}]}',
      status: "completed",
    });
  });

  it("final_answer 受領前の steer は同じturnへ送信する", async () => {
    const transport = new FakeTransport();
    const runtime = await initializeRuntime(transport);

    const starting = runtime.startTurn("thread-1", turnRequest("first"));
    transport.emit({ id: 2, result: { turn: { id: "turn-1" } } });
    await starting;

    const steering = runtime.steerTurn("thread-1", "turn-1", "second");
    expect(transport.writes).toContainEqual({
      id: 3,
      method: "turn/steer",
      params: {
        expectedTurnId: "turn-1",
        input: [{ text: "second", text_elements: [], type: "text" }],
        threadId: "thread-1",
      },
    });
    transport.emit({ id: 3, result: { turnId: "turn-1" } });

    await expect(steering).resolves.toBeUndefined();
  });

  it("同じconnectionへ届く管理外threadのturn通知を管理中turnから分離する", async () => {
    const transport = new FakeTransport();
    const runtime = await initializeRuntime(transport);

    const starting = runtime.startTurn("thread-1", turnRequest("hello"));
    transport.emit({ id: 2, result: { turn: { id: "turn-1" } } });
    const started = await starting;

    transport.emit({
      method: "turn/started",
      params: { threadId: "subagent-thread", turn: { id: "subagent-turn" } },
    });
    transport.emit({
      method: "item/completed",
      params: {
        item: { type: "agentMessage", phase: "final_answer", text: '{"actions":[]}' },
        threadId: "subagent-thread",
        turnId: "subagent-turn",
      },
    });
    transport.emit({
      method: "turn/completed",
      params: {
        threadId: "subagent-thread",
        turn: { error: null, id: "subagent-turn", status: "completed" },
      },
    });
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

    await expect(started.completion).resolves.toMatchObject({ status: "completed" });
  });

  it("管理中threadにactive trackerがないturn通知をprotocol fatalにする", async () => {
    const transport = new FakeTransport();
    const runtime = await initializeRuntime(transport);

    const starting = runtime.startTurn("thread-1", turnRequest("hello"));
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
    await started.completion;

    transport.emit({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "unexpected-turn" } },
    });

    await expect(runtime.startTurn("thread-1", turnRequest("next"))).rejects.toBeInstanceOf(
      JsonRpcProtocolError,
    );
  });

  it("turn/start response と先行通知の turn id 不一致を protocol fatal にする", async () => {
    const transport = new FakeTransport();
    const runtime = await initializeRuntime(transport);

    const starting = runtime.startTurn("thread-1", turnRequest("hello"));
    transport.emit({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-from-notification" } },
    });
    transport.emit({ id: 2, result: { turn: { id: "turn-from-response" } } });

    await expect(starting).rejects.toBeInstanceOf(JsonRpcProtocolError);
  });
});
