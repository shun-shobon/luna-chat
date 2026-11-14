const REDACTED = "[REDACTED]";
const SECRET_FIELDS = new Set(["authorization", "discord_bot_token", "discordbottoken"]);

// pino の redact はパス指定のため、任意の深さ・大文字小文字を問わない秘匿キーは自前で伏せる。
export function serializeLogValue(value: unknown): unknown {
	return serialize(value, new WeakSet());
}

function serialize(value: unknown, seen: WeakSet<object>): unknown {
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			...(value.stack === undefined ? {} : { stack: value.stack }),
			...(value.cause === undefined ? {} : { cause: serialize(value.cause, seen) }),
		};
	}
	if (Array.isArray(value)) return value.map((item) => serialize(item, seen));
	if (typeof value !== "object" || value == null) return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	const output: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		output[key] = SECRET_FIELDS.has(key.toLowerCase()) ? REDACTED : serialize(child, seen);
	}
	return output;
}
