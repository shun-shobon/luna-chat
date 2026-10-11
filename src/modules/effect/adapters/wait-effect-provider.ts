import { z } from "zod";

import { WAIT_EFFECT_TYPE } from "../domain/effect";
import { defineEffect } from "../ports/effect-provider";
import type { EffectProvider } from "../ports/effect-provider";

// Node.jsのsetTimeoutは2^31-1msを超えると1msに丸めるため、秒単位でその範囲に収める。
const waitInputSchema = z.strictObject({
	duration_seconds: z.number().int().min(1).max(2_147_483),
});

export function createWaitEffectProvider(): EffectProvider {
	return Object.freeze({
		definitions: Object.freeze([
			defineEffect({
				type: WAIT_EFFECT_TYPE,
				agentInputSchema: waitInputSchema,
				inputSchema: waitInputSchema,
				parseInput: (input) => input,
				execute: async (input) => {
					await new Promise<void>((resolve) => {
						setTimeout(resolve, input.duration_seconds * 1_000);
					});
					return { duration_seconds: input.duration_seconds };
				},
				describeTarget: () => null,
			}),
		]),
		release: async () => {},
	});
}
