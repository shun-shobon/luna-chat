import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { inject } from "postject";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const distDir = join(root, "dist");
const outputPath = join(distDir, "luna-chat");
const temporaryDir = await mkdtemp(join(distDir, ".sea-build-"));

try {
  const configPath = join(temporaryDir, "sea-config.json");
  const blobPath = join(temporaryDir, "sea-prep.blob");
  const binaryPath = join(temporaryDir, "luna-chat");

  await writeFile(
    configPath,
    JSON.stringify({
      main: join(distDir, "sea", "index.cjs"),
      output: blobPath,
      useCodeCache: false,
      useSnapshot: false,
      assets: {
        "templates/LUNA.md": join(root, "templates", "LUNA.md"),
        "templates/MEMORY.md": join(root, "templates", "MEMORY.md"),
        "templates/HEARTBEAT.md": join(root, "templates", "HEARTBEAT.md"),
        "templates/.agents/skills/cron/SKILL.md": join(
          root,
          "templates",
          ".agents",
          "skills",
          "cron",
          "SKILL.md",
        ),
        "templates/.agents/skills/heartbeat/SKILL.md": join(
          root,
          "templates",
          ".agents",
          "skills",
          "heartbeat",
          "SKILL.md",
        ),
      },
    }),
  );
  await execFileAsync(process.execPath, ["--experimental-sea-config", configPath]);
  await copyFile(process.execPath, binaryPath);

  if (process.platform === "darwin") {
    await execFileAsync("codesign", ["--remove-signature", binaryPath]);
  }

  await inject(binaryPath, "NODE_SEA_BLOB", await readFile(blobPath), {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    machoSegmentName: "NODE_SEA",
  });

  if (process.platform === "darwin") {
    await execFileAsync("codesign", ["--sign", "-", binaryPath]);
  }

  await rename(binaryPath, outputPath);
  console.log(`Built ${outputPath}`);
} finally {
  await rm(temporaryDir, { recursive: true, force: true });
}
