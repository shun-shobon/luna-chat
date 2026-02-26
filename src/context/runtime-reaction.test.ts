import { describe, expect, it } from "vitest";

import { toRuntimeReactions } from "./runtime-reaction";

describe("toRuntimeReactions", () => {
  it("count が正のリアクションのみを絵文字順で返す", () => {
    const reactions = toRuntimeReactions([
      {
        count: 3,
        emojiName: "👍",
        selfReacted: true,
      },
      {
        count: 0,
        emojiName: "🚫",
        selfReacted: true,
      },
      {
        count: 1,
        emojiName: "🎉",
        selfReacted: false,
      },
    ]);

    expect(reactions).toEqual([
      {
        count: 1,
        emoji: "🎉",
      },
      {
        count: 3,
        emoji: "👍",
        selfReacted: true,
      },
    ]);
  });

  it("selfReacted が false のときはフィールドを含めない", () => {
    const reactions = toRuntimeReactions([
      {
        count: 2,
        emojiName: "🔥",
        selfReacted: false,
      },
    ]);

    expect(reactions).toEqual([
      {
        count: 2,
        emoji: "🔥",
      },
    ]);
  });

  it("有効なリアクションがない場合は undefined を返す", () => {
    const reactions = toRuntimeReactions([
      {
        count: 0,
        emojiName: "👍",
        selfReacted: false,
      },
    ]);

    expect(reactions).toBeUndefined();
  });
});
