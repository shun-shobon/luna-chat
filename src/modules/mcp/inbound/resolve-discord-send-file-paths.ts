import { access, constants, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export async function resolveDiscordSendFilePaths(input: {
  filePaths?: readonly string[];
  workspaceDir: string;
}): Promise<string[] | undefined> {
  if (input.filePaths === undefined) {
    return undefined;
  }

  const resolvedWorkspaceDir = resolve(input.workspaceDir);
  const resolvedFilePaths: string[] = [];

  for (const [index, rawFilePath] of input.filePaths.entries()) {
    const resolvedFilePath = await resolveDiscordSendFilePath({
      filePath: rawFilePath,
      index,
      workspaceDir: resolvedWorkspaceDir,
    });
    resolvedFilePaths.push(resolvedFilePath);
  }

  return resolvedFilePaths;
}

async function resolveDiscordSendFilePath(input: {
  filePath: string;
  index: number;
  workspaceDir: string;
}): Promise<string> {
  const trimmedFilePath = input.filePath.trim();
  if (trimmedFilePath.length === 0) {
    throw new Error(`filePaths[${input.index}] must not be empty.`);
  }

  const resolvedFilePath = isAbsolute(trimmedFilePath)
    ? resolve(trimmedFilePath)
    : resolve(input.workspaceDir, trimmedFilePath);

  if (
    !isAbsolute(trimmedFilePath) &&
    !isPathWithinWorkspace(input.workspaceDir, resolvedFilePath)
  ) {
    throw new Error(
      `filePaths[${input.index}] must stay within the workspace when using a relative path.`,
    );
  }

  try {
    await access(resolvedFilePath, constants.R_OK);
    const stats = await stat(resolvedFilePath);
    if (!stats.isFile()) {
      throw new Error("path is not a file");
    }
  } catch {
    throw new Error(`filePaths[${input.index}] must reference a readable file.`);
  }

  return resolvedFilePath;
}

function isPathWithinWorkspace(workspaceDir: string, targetPath: string): boolean {
  const relativePath = relative(workspaceDir, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
