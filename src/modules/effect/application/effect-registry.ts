import type { EffectDefinition, EffectProvider } from "../ports/effect-provider";

export interface EffectRegistry {
  readonly definitions: readonly EffectDefinition[];
  readonly providers: readonly EffectProvider[];
  getDefinition(type: string): EffectDefinition;
}

export function createEffectRegistry(providers: readonly EffectProvider[]): EffectRegistry {
  const immutableProviders = Object.freeze([...providers]);
  const definitions = immutableProviders.flatMap((provider) => provider.definitions);
  if (definitions.length === 0) {
    throw new Error("Effect registry requires at least one definition.");
  }

  const definitionByType = new Map<string, EffectDefinition>();
  for (const definition of definitions) {
    if (definition.type.length === 0) {
      throw new Error("Effect type must not be empty.");
    }
    if (definitionByType.has(definition.type)) {
      throw new Error(`Duplicate effect type registration: ${definition.type}`);
    }
    definitionByType.set(definition.type, definition);
  }

  const immutableDefinitions = Object.freeze([...definitions]);
  return Object.freeze({
    definitions: immutableDefinitions,
    providers: immutableProviders,
    getDefinition: (type: string): EffectDefinition => {
      const definition = definitionByType.get(type);
      if (definition === undefined) {
        throw new Error(`Unknown effect type: ${type}`);
      }
      return definition;
    },
  });
}
