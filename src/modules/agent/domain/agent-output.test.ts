import { describe, expect, it } from "vitest";

import { AGENT_OUTPUT_JSON_SCHEMA, parseAgentOutputText } from "./agent-output";

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$defs",
  "$ref",
  "$schema",
  "additionalProperties",
  "anyOf",
  "const",
  "description",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maximum",
  "maxItems",
  "minimum",
  "minItems",
  "multipleOf",
  "pattern",
  "properties",
  "required",
  "type",
]);

describe("AGENT_OUTPUT_JSON_SCHEMA", () => {
  it("Structured Outputs が受理できる JSON Schema subset に収まる", () => {
    expect(AGENT_OUTPUT_JSON_SCHEMA.type).toBe("object");
    validateStructuredOutputSchema(AGENT_OUTPUT_JSON_SCHEMA);
  });
});

describe("parseAgentOutputText", () => {
  it("nullable field を Discord action の optional field に変換する", () => {
    expect(
      parseAgentOutputText(
        JSON.stringify({
          actions: [
            {
              kind: "send_message",
              target: { kind: "channel", channelId: "123" },
              content: "hello",
              files: null,
            },
            {
              kind: "reply_message",
              channelId: "123",
              messageId: "456",
              content: null,
              files: [
                {
                  path: "/tmp/luna.txt",
                  fileName: null,
                  description: "log",
                },
              ],
            },
            {
              kind: "add_reaction",
              channelId: "123",
              messageId: "456",
              emoji: { kind: "custom", id: "789", name: null },
            },
          ],
        }),
      ),
    ).toEqual({
      actions: [
        {
          kind: "send_message",
          target: { kind: "channel", channelId: "123" },
          content: "hello",
        },
        {
          kind: "reply_message",
          channelId: "123",
          messageId: "456",
          files: [{ path: "/tmp/luna.txt", description: "log" }],
        },
        {
          kind: "add_reaction",
          channelId: "123",
          messageId: "456",
          emoji: { kind: "custom", id: "789" },
        },
      ],
    });
  });

  it("本文も file もない message を拒否する", () => {
    expect(() =>
      parseAgentOutputText(
        JSON.stringify({
          actions: [
            {
              kind: "send_message",
              target: { kind: "channel", channelId: "123" },
              content: null,
              files: null,
            },
          ],
        }),
      ),
    ).toThrow("A message requires content or files");
  });
});

function validateStructuredOutputSchema(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      validateStructuredOutputSchema(item);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const keyword of Object.keys(record)) {
    expect(SUPPORTED_SCHEMA_KEYWORDS).toContain(keyword);
  }

  if (record["type"] === "object") {
    expect(record["additionalProperties"]).toBe(false);
    expect(record["required"]).toEqual(
      Object.keys(record["properties"] as Record<string, unknown>),
    );
  }

  const properties = record["properties"];
  if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
    for (const propertySchema of Object.values(properties)) {
      validateStructuredOutputSchema(propertySchema);
    }
  }
  if (record["items"] !== undefined) {
    validateStructuredOutputSchema(record["items"]);
  }
  if (record["anyOf"] !== undefined) {
    validateStructuredOutputSchema(record["anyOf"]);
  }
}
