import { describe, expect, it } from "vitest";

import { lunaEventSchema } from "./luna-event";

describe("lunaEventSchema", () => {
  it("JSON-safeなEvent envelopeを受理する", () => {
    expect(
      lunaEventSchema.parse({
        id: "event-1",
        type: "test.sensor.changed.v1",
        source: "test/sensor",
        subject: "sensor.temperature",
        occurredAt: "2026-08-09T12:34:56+09:00",
        data: { value: 24.5, labels: ["indoor", null] },
      }),
    ).toEqual({
      id: "event-1",
      type: "test.sensor.changed.v1",
      source: "test/sensor",
      subject: "sensor.temperature",
      occurredAt: "2026-08-09T12:34:56+09:00",
      data: { value: 24.5, labels: ["indoor", null] },
    });
  });

  it.each(["id", "type", "source"] as const)("空の%sを拒否する", (field) => {
    expect(() =>
      lunaEventSchema.parse({
        id: "event-1",
        type: "test.sensor.changed.v1",
        source: "test/sensor",
        occurredAt: "2026-08-09T03:34:56Z",
        data: null,
        [field]: "",
      }),
    ).toThrow();
  });

  it("offsetのない日時を拒否する", () => {
    expect(() =>
      lunaEventSchema.parse({
        id: "event-1",
        type: "test.sensor.changed.v1",
        source: "test/sensor",
        occurredAt: "2026-08-09T12:34:56",
        data: null,
      }),
    ).toThrow();
  });

  it("JSON valueではないdataを拒否する", () => {
    expect(() =>
      lunaEventSchema.parse({
        id: "event-1",
        type: "test.sensor.changed.v1",
        source: "test/sensor",
        occurredAt: "2026-08-09T03:34:56Z",
        data: { invalid: undefined },
      }),
    ).toThrow();
  });

  it("余分なfieldを拒否する", () => {
    expect(() =>
      lunaEventSchema.parse({
        id: "event-1",
        type: "test.sensor.changed.v1",
        source: "test/sensor",
        occurredAt: "2026-08-09T03:34:56Z",
        data: null,
        extra: true,
      }),
    ).toThrow();
  });
});
