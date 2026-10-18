import type { LoggerPort } from "../../observability/ports/logger-port";
import type { EffectExecution, EffectRequest, EffectResult } from "../domain/effect";
import type { EffectBatchPort } from "../ports/effect-batch-port";
import type { EffectRegistry } from "./effect-registry";

export function createEffectBatchExecutor(
	registry: EffectRegistry,
	logger: LoggerPort,
): EffectBatchPort {
	return {
		execute: async (effects, execution) => await executeEffectBatch(effects, execution),
		release: async (ownerId) => {
			const settled = await Promise.allSettled(
				registry.providers.map(async (provider) => await provider.release(ownerId)),
			);
			settled.forEach((result, providerIndex) => {
				if (result.status === "fulfilled") return;
				logger.log(
					"warn",
					"effect.provider_release_failed",
					{},
					{ error: result.reason, ownerId, providerIndex },
				);
			});
		},
	};
}

async function executeEffectBatch(
	effects: readonly EffectRequest[],
	execution: EffectExecution,
): Promise<readonly EffectResult[]> {
	return await Promise.all(
		effects.map(async ({ type, target, run }, index): Promise<EffectResult> => {
			try {
				return { index, type, target, success: true, value: await run(execution) };
			} catch (error: unknown) {
				return { index, type, target, success: false, error: toErrorMessage(error) };
			}
		}),
	);
}

function toErrorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}
