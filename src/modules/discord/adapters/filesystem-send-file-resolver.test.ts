import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FilesystemSendFileResolver } from "./filesystem-send-file-resolver";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true })),
  );
});

describe("FilesystemSendFileResolver", () => {
  it("realpath上の通常fileだけを解決する", async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, "message.txt");
    await writeFile(path, "hello");

    const resolvedPath = await realpath(path);
    await expect(
      new FilesystemSendFileResolver().resolve({ path, fileName: "luna.txt" }),
    ).resolves.toEqual({ path: resolvedPath, fileName: "luna.txt" });
  });

  it("directoryを拒否する", async () => {
    const directory = await createTemporaryDirectory();
    const child = join(directory, "child");
    await mkdir(child);

    await expect(new FilesystemSendFileResolver().resolve({ path: child })).rejects.toThrow(
      "not a regular file",
    );
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "luna-discord-file-"));
  temporaryDirectories.push(directory);
  return directory;
}
