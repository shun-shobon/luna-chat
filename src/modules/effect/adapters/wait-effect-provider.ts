import { z } from "zod";

import { WAIT_EFFECT_TYPE } from "../domain/effect";
import { defineEffect, type EffectProvider } from "../ports/effect-provider";

const waitInputSchema = z.strictObject({ duration_seconds: z.number().int().min(1) });
const MAXIMUM_DELAY_SECONDS = 2_147_483;

export function createWaitEffectProvider(): EffectProvider {
  return Object.freeze({
    definitions: Object.freeze([
      defineEffect({
        type: WAIT_EFFECT_TYPE,
        agentInputSchema: waitInputSchema,
        inputSchema: waitInputSchema,
        parseInput: (input) => input,
        execute: async (input) => {
          let remainingSeconds = input.duration_seconds;
          while (remainingSeconds > 0) {
            const chunkSeconds = Math.min(remainingSeconds, MAXIMUM_DELAY_SECONDS);
            await new Promise<void>((resolve) => {
              setTimeout(resolve, chunkSeconds * 1_000);
            });
            remainingSeconds -= chunkSeconds;
          }
          return { duration_seconds: input.duration_seconds };
        },
        describeTarget: () => null,
      }),
    ]),
    release: async () => {},
  });
}
