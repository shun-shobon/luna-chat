import { readFileSync } from "node:fs";

const DEFAULT_APOLOGY_MESSAGE = "ごめんね、今ちょっと不調みたい。少し待ってくれる？";

export function readApologyTemplate(templatePath: string): string {
  const templateText = readFileSync(templatePath, "utf8").trim();
  if (templateText.length === 0) {
    return DEFAULT_APOLOGY_MESSAGE;
  }

  return templateText;
}
