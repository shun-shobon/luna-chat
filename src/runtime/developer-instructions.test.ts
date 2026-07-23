import { describe, expect, it } from "vitest";

import { LUNA_DEVELOPER_INSTRUCTIONS } from "./developer-instructions";

describe("LUNA_DEVELOPER_INSTRUCTIONS", () => {
  it("固定protocol instructionを保持する", () => {
    expect(LUNA_DEVELOPER_INSTRUCTIONS).toMatchSnapshot();
  });
});
