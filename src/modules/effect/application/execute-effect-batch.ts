import type { JsonValue } from "../../event/domain/luna-event";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type { EffectRequest, EffectResult } from "../domain/effect";
import type { EffectBatchPort } from "../ports/effect-batch-port";
import type { EffectDefinition } from "../ports/effect-provider";

import type { EffectRegistry } from "./effect-registry";

type PreparedEffect = Readonly<{
  definition: EffectDefinition;
  input: JsonValue;
  target: JsonValue;
}>;

export function createEffectBatchExecutor(
  registry: EffectRegistry,
  logger: LoggerPort,
): EffectBatchPort {
  return {
    execute: async (effects, ownerId) => await executeEffectBatch(registry, effects, ownerId),
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
  registry: EffectRegistry,
  effects: readonly EffectRequest[],
  ownerId: string,
): Promise<readonly EffectResult[]> {
  const prepared = effects.map((effect): PreparedEffect => {
    const definition = registry.getDefinition(effect.type);
    return {
      definition,
      input: effect.input,
      target: definition.describeTarget(effect.input),
    };
  });

  const settled = await Promise.allSettled(
    prepared.map(async ({ definition, input }) => await definition.execute(input, ownerId)),
  );

  return settled.map((result, index): EffectResult => {
    const effect = effects[index];
    const preparedEffect = prepared[index];
    if (effect === undefined || preparedEffect === undefined) {
      throw new Error("Effect result lost its input reference.");
    }
    return result.status === "fulfilled"
      ? {
          index,
          type: effect.type,
          target: preparedEffect.target,
          success: true,
          value: result.value,
        }
      : {
          index,
          type: effect.type,
          target: preparedEffect.target,
          success: false,
          error: toErrorMessage(result.reason),
        };
  });
}

function toErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
