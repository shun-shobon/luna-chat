import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readApologyTemplate } from "./apology-template";

describe("readApologyTemplate", () => {
  it("テンプレート本文を読み込む", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "luna-apology-"));
    const templatePath = join(tempDirectory, "apology.md");
    writeFileSync(templatePath, "ごめんね。", "utf8");

    expect(readApologyTemplate(templatePath)).toBe("ごめんね。");
    rmSync(tempDirectory, { force: true, recursive: true });
  });
});
