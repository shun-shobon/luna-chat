import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";

import type { HttpEventService } from "../application/http-event-service";
import { httpEventRequestSchema } from "../domain/http-event";

export type HttpEventServerHandle = Readonly<{
  port: number;
  close(): Promise<void>;
}>;

export async function startHttpEventServer(
  input: Readonly<{
    hostname: string;
    port: number;
    service: HttpEventService;
    onError(error: Error): void;
  }>,
): Promise<HttpEventServerHandle> {
  const app = new Hono();
  app.onError((error, context) => {
    input.onError(error);
    return context.json({ error: "internal_error" }, 500);
  });
  app.post("/events", async (context) => {
    if (
      context.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json"
    ) {
      return context.json({ error: "content_type_must_be_json" }, 415);
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_json" }, 400);
    }
    const parsed = httpEventRequestSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    const result = await input.service.submit(parsed.data);
    if (result.kind === "unavailable") return context.json({ error: "unavailable" }, 503);
    if (result.kind === "accepted") return context.json({ request_id: result.requestId }, 202);
    if (result.outcome.kind === "failed") {
      return context.json({ error: "execution_failed", request_id: result.requestId }, 500);
    }
    if (result.outcome.kind === "no_content") return context.body(null, 204);
    return new Response(JSON.stringify(result.outcome.body), {
      status: result.outcome.status,
      headers: { "content-type": "application/json; charset=UTF-8" },
    });
  });

  const server = await new Promise<{ server: ServerType; port: number }>((resolve, reject) => {
    let started = false;
    const running = serve(
      { fetch: app.fetch, hostname: input.hostname, port: input.port },
      (info) => {
        started = true;
        resolve({ server: running, port: info.port });
      },
    );
    running.on("error", (error) => {
      if (started) input.onError(error);
      else reject(error);
    });
  });

  return {
    port: server.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
