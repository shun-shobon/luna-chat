import type { EffectExecution, EffectRequest, EffectResult } from "../domain/effect";

export interface EffectBatchPort {
	execute(
		effects: readonly EffectRequest[],
		execution: EffectExecution,
	): Promise<readonly EffectResult[]>;
	release(ownerId: string): Promise<void>;
}
