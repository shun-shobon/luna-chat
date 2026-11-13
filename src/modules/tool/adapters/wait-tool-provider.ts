import { z } from "zod";

import { defineTool } from "../ports/tool-provider";
import type { ToolProvider } from "../ports/tool-provider";

// Node.jsのsetTimeoutは2^31-1msを超えると1msに丸めるため、秒単位でその範囲に収める。
const waitInputSchema = z.strictObject({
	duration_seconds: z.number().int().min(1).max(2_147_483),
});

type PendingWait = Readonly<{ cancel(reason: string): void }>;

export function createWaitToolProvider(): ToolProvider {
	const pending = new Map<string, Set<PendingWait>>();

	return Object.freeze({
		definitions: Object.freeze([
			defineTool({
				name: "wait",
				description:
					"Pause for duration_seconds and then continue. Use it to check something again later. New input that arrives meanwhile is delivered after the wait.",
				inputSchema: waitInputSchema,
				parseInput: (input) => input,
				execute: async (input, execution) => {
					await new Promise<void>((resolve, reject) => {
						const waits = pending.get(execution.ownerId) ?? new Set<PendingWait>();
						pending.set(execution.ownerId, waits);
						const finish = (): void => {
							waits.delete(wait);
							if (waits.size === 0) pending.delete(execution.ownerId);
							execution.signal.removeEventListener("abort", onAbort);
						};
						const timer = setTimeout(() => {
							finish();
							resolve();
						}, input.duration_seconds * 1_000);
						const wait: PendingWait = {
							cancel: (reason) => {
								clearTimeout(timer);
								finish();
								reject(new Error(reason));
							},
						};
						const onAbort = (): void => wait.cancel("Wait was aborted");
						waits.add(wait);
						if (execution.signal.aborted) onAbort();
						else execution.signal.addEventListener("abort", onAbort, { once: true });
					});
					return { waited_seconds: input.duration_seconds };
				},
				describeTarget: () => null,
			}),
		]),
		release: (ownerId: string) => {
			for (const wait of pending.get(ownerId) ?? []) wait.cancel("Wait was cancelled");
			return Promise.resolve();
		},
	});
}
