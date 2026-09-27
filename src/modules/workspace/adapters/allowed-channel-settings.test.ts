import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AllowedChannelSettings } from "./allowed-channel-settings";
import { parseWorkspaceConfig } from "./config-toml";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

async function createConfig(source = '[memory]\nenabled = true\nmaintenance_cron = "0 4 * * *"\n') {
  const directory = await mkdtemp(join(tmpdir(), "luna-allowed-channels-"));
  paths.push(directory);
  const path = join(directory, "config.toml");
  await writeFile(path, source);
  return path;
}

describe("AllowedChannelSettings", () => {
  it("追加と削除を保存し、同じ集合へ即時反映する", async () => {
    const path = await createConfig();
    await chmod(path, 0o600);
    const settings = new AllowedChannelSettings(path, []);
    const ids = settings.ids;

    await expect(settings.change("add", "123")).resolves.toBe(true);
    expect(ids.has("123")).toBe(true);
    await expect(settings.change("add", "123")).resolves.toBe(false);
    await expect(settings.change("remove", "123")).resolves.toBe(true);
    expect(ids.has("123")).toBe(false);
    expect(parseWorkspaceConfig(await readFile(path, "utf8")).discord.allowedChannelIds).toEqual(
      [],
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("連続操作を直列化し、最新ファイルの他設定を維持する", async () => {
    const path = await createConfig(
      '[memory]\nenabled = true\nmaintenance_cron = "0 4 * * *"\n[discord]\nallow_dm = false\nallowed_channel_ids = ["100"]\n',
    );
    const settings = new AllowedChannelSettings(path, ["100"]);
    await Promise.all([settings.change("add", "200"), settings.change("add", "300")]);

    const config = parseWorkspaceConfig(await readFile(path, "utf8"));
    expect(config.discord.allowedChannelIds).toEqual(["100", "200", "300"]);
    expect(config.discord.allowDm).toBe(false);
  });

  it("不正ファイルでは保存とメモリ上の設定を変更しない", async () => {
    const path = await createConfig("invalid = true\n");
    const settings = new AllowedChannelSettings(path, ["100"]);
    await expect(settings.change("add", "200")).rejects.toThrow("config.toml is invalid");
    expect(settings.ids.has("100")).toBe(true);
    expect(settings.ids.has("200")).toBe(false);
    expect(await readFile(path, "utf8")).toBe("invalid = true\n");
  });

  it("書き込み失敗時はメモリ上の設定を変更しない", async () => {
    const path = await createConfig();
    const settings = new AllowedChannelSettings(path, []);
    await chmod(dirname(path), 0o500);
    try {
      await expect(settings.change("add", "200")).rejects.toThrow();
      expect(settings.ids.has("200")).toBe(false);
    } finally {
      await chmod(dirname(path), 0o700);
    }
  });
});
