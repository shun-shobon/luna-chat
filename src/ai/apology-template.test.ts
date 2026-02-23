import { describe, expect, it } from "vitest";

import { readApologyTemplate } from "./apology-template";

describe("readApologyTemplate", () => {
  it("固定メッセージを返す", () => {
    expect(readApologyTemplate()).toBe("ごめんね、今ちょっと不調みたい。少し待ってくれる？");
  });
});
