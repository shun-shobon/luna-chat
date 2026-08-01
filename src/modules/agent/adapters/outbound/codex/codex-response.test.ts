import { describe, expect, it } from "vitest";

import { parseThreadList } from "./codex-response";

describe("Codex response parser", () => {
  it("updatedAtがないthread summaryを受理する", () => {
    expect(
      parseThreadList(
        {
          backwardsCursor: null,
          data: [{ id: "thread-1" }],
          nextCursor: null,
        },
        true,
      ),
    ).toEqual({ data: [{ archived: true, id: "thread-1" }] });
  });
});
