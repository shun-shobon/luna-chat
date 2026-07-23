import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

const CODEX_CLI_MODULE_ID = "@openai/codex/bin/codex.js";

type ResolveModule = (moduleId: string) => string;
type ResolveRealPath = (path: string) => string;

export function resolveCodexExecutable(input?: {
  realpath?: ResolveRealPath;
  resolveModule?: ResolveModule;
}): string {
  const require = createRequire(import.meta.url);
  const resolveModule = input?.resolveModule ?? ((moduleId) => require.resolve(moduleId));
  const realpath = input?.realpath ?? realpathSync;
  const resolved = realpath(resolveModule(CODEX_CLI_MODULE_ID));

  if (!isAbsolute(resolved)) {
    throw new Error("Resolved @openai/codex executable path must be absolute.");
  }

  return resolved;
}

export function createCodexChildEnvironment(
  parentEnvironment: NodeJS.ProcessEnv,
  codexHomeDir: string,
): NodeJS.ProcessEnv {
  if (!isAbsolute(codexHomeDir)) {
    throw new Error("CODEX_HOME must be an absolute path.");
  }

  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnvironment)) {
    if (typeof value === "string" && key !== "DISCORD_BOT_TOKEN") {
      environment[key] = value;
    }
  }
  environment["CODEX_HOME"] = codexHomeDir;
  return environment;
}
