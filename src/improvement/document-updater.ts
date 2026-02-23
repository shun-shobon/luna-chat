import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";

export type ImprovementUpdateResult = {
  targetPath: string;
  updated: boolean;
};

export function applyImprovementProposal(
  workspaceDir: string,
  proposal: string,
): ImprovementUpdateResult {
  const parsedProposal = parseImprovementProposal(proposal);
  const targetPath = resolve(workspaceDir, parsedProposal.relativePath);

  const workspacePrefix = `${workspaceDir}${sep}`;
  if (targetPath !== workspaceDir && !targetPath.startsWith(workspacePrefix)) {
    throw new Error("Improvement target must be inside CODEX_WORKSPACE_DIR.");
  }
  if (extname(targetPath) !== ".md") {
    throw new Error("Improvement target must be a markdown file.");
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, parsedProposal.content, "utf8");

  return {
    targetPath,
    updated: true,
  };
}

type ParsedProposal = {
  relativePath: string;
  content: string;
};

function parseImprovementProposal(proposal: string): ParsedProposal {
  const lines = proposal.split("\n");
  const header = lines[0]?.trim();
  if (!header?.startsWith("FILE:")) {
    throw new Error("Improvement proposal must start with `FILE: <path>`.");
  }

  const relativePath = header.replace("FILE:", "").trim();
  if (relativePath.length === 0) {
    throw new Error("Improvement proposal file path is empty.");
  }

  const content = lines.slice(1).join("\n").trimStart();
  if (content.length === 0) {
    throw new Error("Improvement proposal content is empty.");
  }

  return {
    relativePath,
    content,
  };
}
