import { z } from "zod";

export const jsonValueSchema = z.json();

export const lunaEventSchema = z.strictObject({
  id: z.string().min(1),
  type: z.string().min(1),
  source: z.string().min(1),
  subject: z.string().optional(),
  occurredAt: z.iso.datetime({ offset: true }),
  data: jsonValueSchema,
});

export type JsonValue = z.infer<typeof jsonValueSchema>;
export type LunaEvent = Readonly<z.infer<typeof lunaEventSchema>>;
