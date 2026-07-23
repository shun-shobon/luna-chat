import type { JsonValue } from "../../../../../generated/codex/serde_json/JsonValue";

export function parseJsonValue(value: unknown, path = "value"): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => parseJsonValue(item, `${path}[${String(index)}]`));
  }
  if (typeof value === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) {
        throw new Error(`${path}.${key} must not be undefined.`);
      }
      result[key] = parseJsonValue(child, `${path}.${key}`);
    }
    return result;
  }
  throw new Error(`${path} is not a JSON value.`);
}

export function parseJsonConfig(config: Record<string, unknown>): { [key: string]: JsonValue } {
  const result: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(config)) {
    result[key] = parseJsonValue(value, `config.${key}`);
  }
  return result;
}
