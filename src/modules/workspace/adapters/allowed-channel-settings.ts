import { randomUUID } from "node:crypto";
import { chmod, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readWorkspaceConfig, serializeWorkspaceConfig } from "./config-toml";

export type AllowedChannelChange = "add" | "remove";

export class AllowedChannelSettings {
  readonly #ids: Set<string>;
  #pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly configPath: string,
    initialIds: readonly string[],
  ) {
    this.#ids = new Set(initialIds);
  }

  get ids(): ReadonlySet<string> {
    return this.#ids;
  }

  change(action: AllowedChannelChange, channelId: string): Promise<boolean> {
    const operation = this.#pending.then(async () => {
      const config = await readWorkspaceConfig(this.configPath);
      const ids = new Set(config.discord.allowedChannelIds);
      const changed = action === "add" ? !ids.has(channelId) : ids.has(channelId);
      if (changed) {
        if (action === "add") ids.add(channelId);
        else ids.delete(channelId);
        config.discord.allowedChannelIds = [...ids];
        await writeConfig(this.configPath, serializeWorkspaceConfig(config));
      }
      this.#ids.clear();
      for (const id of ids) this.#ids.add(id);
      return changed;
    });
    this.#pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

async function writeConfig(path: string, source: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.config.toml.${randomUUID()}.tmp`);
  const { mode } = await stat(path);
  try {
    await writeFile(temporaryPath, source, { flag: "wx", mode: mode & 0o777 });
    await chmod(temporaryPath, mode & 0o777);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
