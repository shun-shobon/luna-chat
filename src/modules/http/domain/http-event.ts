import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { ConversationSession } from "../../conversation/domain/conversation-session";
import { jsonValueSchema, lunaEventSchema, type LunaEvent } from "../../event/domain/luna-event";

export const HTTP_EVENT_SOURCE = "http";

const eventInputSchema = z.strictObject({
  type: z.string().min(1),
  data: jsonValueSchema,
});

export const httpEventRequestSchema = z.discriminatedUnion("execution", [
  z.strictObject({
    execution: z.literal("one_shot"),
    response_mode: z.enum(["async", "wait"]),
    event: eventInputSchema,
  }),
  z.strictObject({
    execution: z.literal("conversation"),
    response_mode: z.enum(["async", "wait"]),
    session_id: z.string().min(1).max(128),
    event: eventInputSchema,
  }),
]);

export type HttpEventRequest = z.infer<typeof httpEventRequestSchema>;

export function createHttpEvent(request: HttpEventRequest): LunaEvent {
  return lunaEventSchema.parse({
    id: randomUUID(),
    type: request.event.type,
    source: HTTP_EVENT_SOURCE,
    occurredAt: new Date().toISOString(),
    data: {
      payload: request.event.data,
      response_mode: request.response_mode,
    },
  });
}

export function createHttpConversationSession(sessionId: string): ConversationSession {
  return {
    key: `http:${sessionId}`,
    source: HTTP_EVENT_SOURCE,
    context: { session_id: sessionId },
  };
}
