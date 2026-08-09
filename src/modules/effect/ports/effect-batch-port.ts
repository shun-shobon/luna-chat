import type { EffectRequest, EffectResult } from "../domain/effect";

export interface EffectBatchPort {
  execute(effects: readonly EffectRequest[], ownerId: string): Promise<readonly EffectResult[]>;
  release(ownerId: string): Promise<void>;
}
