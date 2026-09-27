import { describe, expect, it } from "vitest";

import { parseModelList, parseThreadList } from "./codex-response";

describe("Codex response parser", () => {
  it("model/listの表示可能モデルと対応強度を検証する", () => {
    expect(
      parseModelList({
        data: [
          {
            model: "gpt-6-sol",
            displayName: "GPT-6 Sol",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          },
          {
            model: "hidden",
            displayName: "Hidden",
            hidden: true,
            supportedReasoningEfforts: [],
          },
        ],
        nextCursor: null,
      }),
    ).toEqual({
      data: [
        { model: "gpt-6-sol", displayName: "GPT-6 Sol", supportedReasoningEfforts: ["medium"] },
      ],
      nextCursor: null,
    });
    expect(() => parseModelList({ data: [{ model: 1 }], nextCursor: null })).toThrow();
  });

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
