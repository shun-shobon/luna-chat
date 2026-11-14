export function matchesEntityPattern(pattern: string, entityId: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/gu, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`, "u").test(entityId);
}

export function matchesAnyEntityPattern(patterns: readonly string[], entityId: string): boolean {
	return patterns.some((pattern) => matchesEntityPattern(pattern, entityId));
}
