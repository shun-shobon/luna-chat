import { z } from "zod";

import { WAIT_EFFECT_TYPE } from "../domain/effect";
import { defineEffect } from "../ports/effect-provider";
import type { EffectProvider } from "../ports/effect-provider";

// Node.jsのsetTimeoutは2^31-1msを超えると1msに丸めるため、秒単位でその範囲に収める。
const waitInputSchema = z.strictObject({
	duration_seconds: z.number().int().min(1).max(2_147_483),
});

type PendingWait = Readonly<{ cancel(): void }>;

export function createWaitEffectProvider(): EffectProvider {
	const pending = new Map<string, Set<PendingWait>>();

	return Object.freeze({
		definitions: Object.freeze([
			defineEffect({
				type: WAIT_EFFECT_TYPE,
				agentInputSchema: waitInputSchema,
				parseInput: (input) => input,
				execute: async (input, execution) => {
					await new Promise<void>((resolve, reject) => {
						const waits = pending.get(execution.ownerId) ?? new Set<PendingWait>();
						pending.set(execution.ownerId, waits);
						const finish = (): void => {
							waits.delete(wait);
							if (waits.size === 0) pending.delete(execution.ownerId);
						};
						const timer = setTimeout(() => {
							finish();
							resolve();
						}, input.duration_seconds * 1_000);
						const wait: PendingWait = {
							cancel: () => {
								clearTimeout(timer);
								finish();
								reject(new Error("Wait was cancelled"));
							},
						};
						waits.add(wait);
					});
					return { duration_seconds: input.duration_seconds };
				},
				describeTarget: () => null,
			}),
		]),
		release: (ownerId: string) => {
			for (const wait of pending.get(ownerId) ?? []) wait.cancel();
			return Promise.resolve();
		},
	});
}
