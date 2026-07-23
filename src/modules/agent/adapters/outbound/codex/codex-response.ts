import { z } from "zod";

import type { AgentThreadSummary } from "../../../ports/outbound/agent-runtime-port";

const nonEmptyStringSchema = z.string().min(1);
const emptyResponseSchema = z.strictObject({});
const initializeResponseSchema = z.looseObject({
  codexHome: nonEmptyStringSchema,
  platformFamily: nonEmptyStringSchema,
  platformOs: nonEmptyStringSchema,
  userAgent: nonEmptyStringSchema,
});
const threadStartResponseSchema = z.looseObject({
  thread: z.looseObject({ id: nonEmptyStringSchema }),
});
const turnStartResponseSchema = z.looseObject({
  turn: z.looseObject({ id: nonEmptyStringSchema }),
});
const turnSteerResponseSchema = z.strictObject({ turnId: nonEmptyStringSchema });
const threadListResponseSchema = z.looseObject({
  backwardsCursor: z.string().nullable(),
  data: z.array(
    z.looseObject({
      id: nonEmptyStringSchema,
      updatedAt: z.number().int().nonnegative().optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export function parseEmptyResponse(value: unknown): void {
  emptyResponseSchema.parse(value);
}

export function parseInitializeResponse(value: unknown): void {
  initializeResponseSchema.parse(value);
}

export function parseThreadId(value: unknown): string {
  return threadStartResponseSchema.parse(value).thread.id;
}

export function parseTurnId(value: unknown): string {
  return turnStartResponseSchema.parse(value).turn.id;
}

export function parseSteeredTurnId(value: unknown): string {
  return turnSteerResponseSchema.parse(value).turnId;
}

export function parseThreadList(
  value: unknown,
  archived: boolean,
): { data: AgentThreadSummary[]; nextCursor?: string } {
  const response = threadListResponseSchema.parse(value);
  return {
    data: response.data.map((thread) => ({
      archived,
      id: thread.id,
      ...(thread.updatedAt === undefined ? {} : { updatedAt: thread.updatedAt }),
    })),
    ...(response.nextCursor === null ? {} : { nextCursor: response.nextCursor }),
  };
}
