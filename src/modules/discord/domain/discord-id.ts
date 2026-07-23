import { z } from "zod";

export const discordIdSchema = z.string().regex(/^\d+$/u, "Discord ID must be a snowflake string");
