import { afterEach, describe, expect, it, vi } from "vitest";

import type { AcceptedConversationEvent } from "../../conversation/domain/conversation-session";
import type { LunaEvent } from "../../event/domain/luna-event";
import type { EventExecutionPort } from "../../event/ports/event-execution-port";
import { HttpEventService } from "../application/http-event-service";
import { HttpResponseRegistry } from "../application/http-response-registry";

import { startHttpEventServer, type HttpEventServerHandle } from "./http-event-server";
import { createHttpResponseEffectProvider } from "./http-response-effect-provider";

const servers: HttpEventServerHandle[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
});

describe("HTTP event server", () => {
  it("ワンショットの非同期受付は202を返し、イベントを生成する", async () => {
    const completion = deferred();
    const events: LunaEvent[] = [];
    const { service, url } = await start({
      execute: async (event) => {
        events.push(event);
        await completion.promise;
        return { status: "completed" };
      },
    });

    const response = await post(url, {
      execution: "one_shot",
      response_mode: "async",
      event: { type: "sensor.changed.v1", data: { value: 24 } },
    });

    expect(response.status).toBe(202);
    const accepted: unknown = await response.json();
    expect(accepted).toEqual({ request_id: events[0]?.id });
    expect(events[0]).toMatchObject({
      type: "sensor.changed.v1",
      source: "http",
      data: { payload: { value: 24 }, response_mode: "async" },
    });
    expect(Date.parse(events[0]?.occurredAt ?? "")).not.toBeNaN();
    completion.resolve();
    await service.drain();
  });

  it("ワンショット完了後にhttp.respondのJSONを返す", async () => {
    const completion = deferred();
    let event: LunaEvent | undefined;
    const { registry, url } = await start({
      execute: async (input) => {
        event = input;
        await completion.promise;
        return { status: "completed" };
      },
    });
    const waiting = post(url, {
      execution: "one_shot",
      response_mode: "wait",
      event: { type: "question.received.v1", data: { question: "hello" } },
    });
    await vi.waitFor(() => expect(event).toBeDefined());
    const provider = createHttpResponseEffectProvider(registry);
    const effect = provider.definitions[0];
    if (event === undefined || effect === undefined) throw new Error("Missing event or effect");
    const requestId = event.id;
    const input = effect.parseInput({
      request_id: requestId,
      status: 201,
      body_json: '{"answer":"world"}',
    });
    await effect.execute(input, "owner-1");
    let responded = false;
    void waiting.then(() => {
      responded = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(responded).toBe(false);
    completion.resolve();

    const response = await waiting;
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ answer: "world" });
    expect(() =>
      effect.parseInput({ request_id: requestId, status: 200, body_json: "{" }),
    ).toThrow();
    await expect(effect.execute(input, "owner-1")).rejects.toThrow("not waiting");
  });

  it("会話セッションの複数リクエストをIDごとに返し、返答なしは204とする", async () => {
    const accepted: AcceptedConversationEvent[] = [];
    const { registry, url } = await start({
      accept: (input) => {
        accepted.push(input);
        return true;
      },
    });
    const first = post(url, {
      execution: "conversation",
      response_mode: "wait",
      session_id: "sensor-room",
      event: { type: "sensor.changed.v1", data: { value: 1 } },
    });
    const second = post(url, {
      execution: "conversation",
      response_mode: "wait",
      session_id: "sensor-room",
      event: { type: "sensor.changed.v1", data: { value: 2 } },
    });
    await vi.waitFor(() => expect(accepted).toHaveLength(2));
    expect(accepted[0]?.session).toEqual({
      key: "http:sensor-room",
      source: "http",
      context: { session_id: "sensor-room" },
    });
    expect(accepted[1]?.session.key).toBe(accepted[0]?.session.key);
    const firstId = accepted.find(
      (input) =>
        JSON.stringify(input.event.data) === '{"payload":{"value":1},"response_mode":"wait"}',
    )?.event.id;
    const secondId = accepted.find(
      (input) =>
        JSON.stringify(input.event.data) === '{"payload":{"value":2},"response_mode":"wait"}',
    )?.event.id;
    if (firstId === undefined || secondId === undefined) throw new Error("Missing request IDs");
    registry.record(firstId, 200, { value: "first" });
    registry.complete(firstId, true);
    registry.complete(secondId, true);

    const firstResponse = await first;
    const secondResponse = await second;
    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual({ value: "first" });
    expect(secondResponse.status).toBe(204);
    expect(await secondResponse.text()).toBe("");
  });

  it("不正な入力と実行失敗を明確なHTTPステータスで返す", async () => {
    const { service, url } = await start({
      execute: async () => ({ status: "failed", error: new Error("failed") }),
    });
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(415);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(url, {
          execution: "one_shot",
          response_mode: "wait",
          event: { type: "", data: null },
        })
      ).status,
    ).toBe(400);
    const failed = await post(url, {
      execution: "one_shot",
      response_mode: "wait",
      event: { type: "test.event.v1", data: null },
    });
    expect(failed.status).toBe(500);
    service.stopIntake();
    expect(
      (
        await post(url, {
          execution: "one_shot",
          response_mode: "async",
          event: { type: "test.event.v1", data: null },
        })
      ).status,
    ).toBe(503);
  });

  it("会話への投入で例外が起きた場合は500を返し、待機登録を残さない", async () => {
    const { registry, url } = await start({
      accept: () => {
        throw new Error("conversation failed");
      },
    });
    const complete = vi.spyOn(registry, "complete");
    const response = await post(url, {
      execution: "conversation",
      response_mode: "wait",
      session_id: "room",
      event: { type: "test.event.v1", data: null },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(complete).toHaveBeenCalledWith(expect.any(String), false);
  });
});

async function start(overrides: {
  accept?: (input: AcceptedConversationEvent) => boolean;
  execute?: EventExecutionPort["execute"];
}) {
  const registry = new HttpResponseRegistry();
  const service = new HttpEventService({
    conversation: { accept: overrides.accept ?? (() => true) },
    executor: { execute: overrides.execute ?? (async () => ({ status: "completed" })) },
    responses: registry,
  });
  const server = await startHttpEventServer({
    hostname: "127.0.0.1",
    port: 0,
    service,
    onError: vi.fn(),
  });
  servers.push(server);
  return { registry, service, url: `http://127.0.0.1:${server.port}/events` };
}

async function post(url: string, body: unknown): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      if (resolvePromise === undefined) throw new Error("Deferred promise was not initialized");
      resolvePromise();
    },
  };
}
