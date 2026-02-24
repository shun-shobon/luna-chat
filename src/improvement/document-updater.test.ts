import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyImprovementProposal } from "./document-updater";

describe("applyImprovementProposal", () => {
  let workspaceDir = "";

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "umbra-improvement-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { force: true, recursive: true });
  });

  it("ワークスペース配下の markdown を更新できる", () => {
    const result = applyImprovementProposal(
      workspaceDir,
      "FILE: persona/style.md\n優しい口調を保つ。",
    );

    expect(result.updated).toBe(true);
    expect(readFileSync(result.targetPath, "utf8")).toBe("優しい口調を保つ。");
  });

  it("markdown 以外は拒否する", () => {
    expect(() =>
      applyImprovementProposal(workspaceDir, "FILE: persona/style.txt\nthis should fail"),
    ).toThrowError();
  });

  it("ワークスペース外へのパストラバーサルを拒否する", () => {
    expect(() =>
      applyImprovementProposal(workspaceDir, "FILE: ../../outside.md\nthis should fail"),
    ).toThrowError();
  });
});
