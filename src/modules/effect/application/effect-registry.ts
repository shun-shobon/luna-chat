import type { EffectDefinition, EffectProvider } from "../ports/effect-provider";

export interface EffectRegistry {
	readonly definitions: readonly EffectDefinition[];
	readonly providers: readonly EffectProvider[];
	getDefinition(type: string): EffectDefinition;
}

export function createEffectRegistry(providers: readonly EffectProvider[]): EffectRegistry {
	const definitions = providers.flatMap((provider) => provider.definitions);
	const definitionByType = new Map(definitions.map((definition) => [definition.type, definition]));

	return Object.freeze({
		definitions,
		providers,
		getDefinition: (type: string): EffectDefinition => {
			const definition = definitionByType.get(type);
			if (definition === undefined) {
				throw new Error(`Unknown effect type: ${type}`);
			}
			return definition;
		},
	});
}
