import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { parseTOML } from "confbox";
import { describe, expect, it } from "vitest";

import { loadRuntimeConfig, RuntimeConfigError } from "./runtime-config";

const DEFAULT_HEARTBEAT_CRON_TIME = "0 0,30 * * * *";

describe("loadRuntimeConfig", () => {
  it("必須設定のみ読み込む", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      createConfigToml({
        allowedChannelIds: ["111", " 222 ", "333", "222", " "],
      }),
    );

    const config = await loadRuntimeConfig({
      LUNA_HOME: lunaHomeDir,
      DISCORD_BOT_TOKEN: "token",
    });

    expect(config.discordBotToken).toBe("token");
    expect(Array.from(config.allowedChannelIds)).toEqual(["111", "222", "333"]);
    expect(config.allowDm).toBe(false);
    expect(config.heartbeatCronTime).toBe(DEFAULT_HEARTBEAT_CRON_TIME);
    expect(config.timeZone).toBeUndefined();
    expect(config.lunaHomeDir).toBe(resolve(lunaHomeDir));
    expect(config.codexWorkspaceDir).toBe(resolve(lunaHomeDir, "workspace"));
    expect(config.codexHomeDir).toBe(resolve(lunaHomeDir, "codex"));
    expect(config.logsDir).toBe(resolve(lunaHomeDir, "logs"));

    await rm(config.lunaHomeDir, {
      force: true,
      recursive: true,
    });
  });

  it("LUNA_HOME が ~/ 形式ならホーム配下へ展開する", async () => {
    const originalHome = process.env["HOME"];
    const testHome = createTempLunaHomeDir();
    await mkdir(testHome, {
      recursive: true,
    });
    process.env["HOME"] = testHome;

    const relativeLunaHome = `.luna-runtime-config-test-${Date.now()}`;
    const expandedLunaHome = resolve(testHome, relativeLunaHome);
    await writeConfigToml(
      expandedLunaHome,
      createConfigToml({
        allowedChannelIds: ["111"],
      }),
    );

    try {
      const config = await loadRuntimeConfig({
        LUNA_HOME: `~/${relativeLunaHome}`,
        DISCORD_BOT_TOKEN: "token",
      });

      expect(config.lunaHomeDir).toBe(expandedLunaHome);
      expect(config.codexWorkspaceDir).toBe(resolve(expandedLunaHome, "workspace"));
      expect(config.codexHomeDir).toBe(resolve(expandedLunaHome, "codex"));
      expect(config.logsDir).toBe(resolve(expandedLunaHome, "logs"));

      await rm(config.lunaHomeDir, {
        force: true,
        recursive: true,
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = originalHome;
      }
      await rm(testHome, {
        force: true,
        recursive: true,
      });
    }
  });

  it("config.toml の allow_dm を読み込む", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      createConfigToml({
        allowDm: true,
        allowedChannelIds: ["111"],
      }),
    );

    try {
      const config = await loadRuntimeConfig({
        LUNA_HOME: lunaHomeDir,
        DISCORD_BOT_TOKEN: "token",
      });

      expect(config.allowDm).toBe(true);
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("config.toml の heartbeat 設定を読み込む", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      createConfigToml({
        allowedChannelIds: ["111"],
        heartbeat: {
          cronTime: "0 */15 * * * *",
        },
      }),
    );

    try {
      const config = await loadRuntimeConfig({
        LUNA_HOME: lunaHomeDir,
        DISCORD_BOT_TOKEN: "token",
      });

      expect(config.heartbeatCronTime).toBe("0 */15 * * * *");
      expect(config.timeZone).toBeUndefined();
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("config.toml のトップレベル time_zone を読み込む", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      createConfigToml({
        allowedChannelIds: ["111"],
        timeZone: "UTC",
      }),
    );

    try {
      const config = await loadRuntimeConfig({
        LUNA_HOME: lunaHomeDir,
        DISCORD_BOT_TOKEN: "token",
      });

      expect(config.timeZone).toBe("UTC");
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("config.toml がなければ自動生成し空配列で起動する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();

    try {
      const config = await loadRuntimeConfig({
        LUNA_HOME: lunaHomeDir,
        DISCORD_BOT_TOKEN: "token",
      });

      expect(Array.from(config.allowedChannelIds)).toEqual([]);
      expect(await exists(resolve(lunaHomeDir, "config.toml"))).toBe(true);
      const generatedConfigToml = await readFile(resolve(lunaHomeDir, "config.toml"), "utf8");
      expect(parseTOML(generatedConfigToml)).toEqual({
        discord: {
          allow_dm: false,
          allowed_channel_ids: [],
        },
        heartbeat: {
          cron_time: DEFAULT_HEARTBEAT_CRON_TIME,
        },
      });
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("workspace と codex と logs ディレクトリを自動作成する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      createConfigToml({
        allowedChannelIds: ["111"],
      }),
    );
    const workspaceDir = resolve(lunaHomeDir, "workspace");
    const codexHomeDir = resolve(lunaHomeDir, "codex");
    const logsDir = resolve(lunaHomeDir, "logs");
    await rm(workspaceDir, {
      force: true,
      recursive: true,
    });
    await rm(codexHomeDir, {
      force: true,
      recursive: true,
    });
    await rm(logsDir, {
      force: true,
      recursive: true,
    });

    await loadRuntimeConfig({
      LUNA_HOME: lunaHomeDir,
      DISCORD_BOT_TOKEN: "token",
    });

    expect(await exists(workspaceDir)).toBe(true);
    expect(await exists(codexHomeDir)).toBe(true);
    expect(await exists(logsDir)).toBe(true);

    await rm(lunaHomeDir, {
      force: true,
      recursive: true,
    });
  });

  it("workspace に templates の不足ファイルを補完する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      createConfigToml({
        allowedChannelIds: ["111"],
      }),
    );
    const templatesDir = await createTempTemplatesDir({
      "LUNA.md": "LUNA template",
      "SOUL.md": "SOUL template",
    });
    try {
      await loadRuntimeConfig(
        {
          LUNA_HOME: lunaHomeDir,
          DISCORD_BOT_TOKEN: "token",
        },
        {
          templatesDir,
        },
      );

      expect(await readFile(resolve(lunaHomeDir, "workspace", "LUNA.md"), "utf8")).toBe(
        "LUNA template",
      );
      expect(await readFile(resolve(lunaHomeDir, "workspace", "SOUL.md"), "utf8")).toBe(
        "SOUL template",
      );
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
      await rm(templatesDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("workspace に既存ファイルがあれば templates で上書きしない", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      createConfigToml({
        allowedChannelIds: ["111"],
      }),
    );
    const workspaceDir = resolve(lunaHomeDir, "workspace");
    const templatesDir = await createTempTemplatesDir({
      "LUNA.md": "LUNA template",
      "SOUL.md": "SOUL template",
    });
    await mkdir(workspaceDir, {
      recursive: true,
    });
    await writeFile(resolve(workspaceDir, "LUNA.md"), "custom LUNA");

    try {
      await loadRuntimeConfig(
        {
          LUNA_HOME: lunaHomeDir,
          DISCORD_BOT_TOKEN: "token",
        },
        {
          templatesDir,
        },
      );

      expect(await readFile(resolve(workspaceDir, "LUNA.md"), "utf8")).toBe("custom LUNA");
      expect(await readFile(resolve(workspaceDir, "SOUL.md"), "utf8")).toBe("SOUL template");
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
      await rm(templatesDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("templates 配下の通常ファイルを再帰で workspace へ補完する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      createConfigToml({
        allowedChannelIds: ["111"],
      }),
    );
    const templatesDir = await createTempTemplatesDir({
      "LUNA.md": "LUNA template",
    });
    const nestedDir = resolve(templatesDir, "nested");
    await mkdir(nestedDir, {
      recursive: true,
    });
    await writeFile(resolve(nestedDir, "SOUL.md"), "nested");

    try {
      await loadRuntimeConfig(
        {
          LUNA_HOME: lunaHomeDir,
          DISCORD_BOT_TOKEN: "token",
        },
        {
          templatesDir,
        },
      );

      expect(await exists(resolve(lunaHomeDir, "workspace", "LUNA.md"))).toBe(true);
      expect(await readFile(resolve(lunaHomeDir, "workspace", "nested", "SOUL.md"), "utf8")).toBe(
        "nested",
      );
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
      await rm(templatesDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("workspace に既存ディレクトリ/ファイルがあれば templates 配下でも上書きしない", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      createConfigToml({
        allowedChannelIds: ["111"],
      }),
    );
    const workspaceDir = resolve(lunaHomeDir, "workspace");
    const templatesDir = await createTempTemplatesDir({
      "nested/LUNA.md": "template nested LUNA",
      "nested/SOUL.md": "template nested SOUL",
    });
    await mkdir(resolve(workspaceDir, "nested"), {
      recursive: true,
    });
    await writeFile(resolve(workspaceDir, "nested", "LUNA.md"), "custom nested LUNA");

    try {
      await loadRuntimeConfig(
        {
          LUNA_HOME: lunaHomeDir,
          DISCORD_BOT_TOKEN: "token",
        },
        {
          templatesDir,
        },
      );

      expect(await readFile(resolve(workspaceDir, "nested", "LUNA.md"), "utf8")).toBe(
        "custom nested LUNA",
      );
      expect(await readFile(resolve(workspaceDir, "nested", "SOUL.md"), "utf8")).toBe(
        "template nested SOUL",
      );
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
      await rm(templatesDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("templates ディレクトリが存在しない場合は失敗する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      createConfigToml({
        allowedChannelIds: ["111"],
      }),
    );
    const missingTemplatesDir = createTempLunaHomeDir();
    try {
      await expect(
        loadRuntimeConfig(
          {
            LUNA_HOME: lunaHomeDir,
            DISCORD_BOT_TOKEN: "token",
          },
          {
            templatesDir: missingTemplatesDir,
          },
        ),
      ).rejects.toThrowError(RuntimeConfigError);
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("templates が空ディレクトリでも起動継続する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      createConfigToml({
        allowedChannelIds: ["111"],
      }),
    );
    const templatesDir = await createTempTemplatesDir({});

    try {
      await expect(
        loadRuntimeConfig(
          {
            LUNA_HOME: lunaHomeDir,
            DISCORD_BOT_TOKEN: "token",
          },
          {
            templatesDir,
          },
        ),
      ).resolves.toBeDefined();
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
      await rm(templatesDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("templates 配下にシンボリックリンクがあれば失敗する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      createConfigToml({
        allowedChannelIds: ["111"],
      }),
    );
    const templatesDir = await createTempTemplatesDir({
      "LUNA.md": "LUNA template",
      "targets/SOUL.md": "target",
    });
    await symlink(resolve(templatesDir, "targets", "SOUL.md"), resolve(templatesDir, "SOUL.link"));

    try {
      await expect(
        loadRuntimeConfig(
          {
            LUNA_HOME: lunaHomeDir,
            DISCORD_BOT_TOKEN: "token",
          },
          {
            templatesDir,
          },
        ),
      ).rejects.toThrowError(RuntimeConfigError);
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
      await rm(templatesDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("workspace の同名パスがファイル以外なら失敗する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      createConfigToml({
        allowedChannelIds: ["111"],
      }),
    );
    const workspaceDir = resolve(lunaHomeDir, "workspace");
    const templatesDir = await createTempTemplatesDir({
      "LUNA.md": "LUNA template",
    });
    await mkdir(resolve(workspaceDir, "LUNA.md"), {
      recursive: true,
    });

    try {
      await expect(
        loadRuntimeConfig(
          {
            LUNA_HOME: lunaHomeDir,
            DISCORD_BOT_TOKEN: "token",
          },
          {
            templatesDir,
          },
        ),
      ).rejects.toThrowError(RuntimeConfigError);
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
      await rm(templatesDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("workspace のネスト先同名パスがファイル以外なら失敗する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      createConfigToml({
        allowedChannelIds: ["111"],
      }),
    );
    const workspaceDir = resolve(lunaHomeDir, "workspace");
    const templatesDir = await createTempTemplatesDir({
      "nested/LUNA.md": "LUNA template",
    });
    await mkdir(workspaceDir, {
      recursive: true,
    });
    await writeFile(resolve(workspaceDir, "nested"), "conflict");

    try {
      await expect(
        loadRuntimeConfig(
          {
            LUNA_HOME: lunaHomeDir,
            DISCORD_BOT_TOKEN: "token",
          },
          {
            templatesDir,
          },
        ),
      ).rejects.toThrowError(RuntimeConfigError);
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
      await rm(templatesDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("config.toml の TOML 構文が不正なら失敗する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      `[discord
allowed_channel_ids = ["111"]
`,
    );

    try {
      await expect(
        loadRuntimeConfig({
          LUNA_HOME: lunaHomeDir,
          DISCORD_BOT_TOKEN: "token",
        }),
      ).rejects.toThrowError(RuntimeConfigError);
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("config.toml の allowed_channel_ids が配列でなければ失敗する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      `[discord]
allowed_channel_ids = "111,222"
`,
    );

    try {
      await expect(
        loadRuntimeConfig({
          LUNA_HOME: lunaHomeDir,
          DISCORD_BOT_TOKEN: "token",
        }),
      ).rejects.toThrowError(RuntimeConfigError);
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("config.toml に [ai] があっても無視して起動継続する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      `[discord]
allowed_channel_ids = ["111"]

[ai]
model = "gpt-5.3-codex"
reasoning_effort = "turbo"

[heartbeat]
cron_time = "0 0,30 * * * *"
`,
    );

    try {
      const config = await loadRuntimeConfig({
        LUNA_HOME: lunaHomeDir,
        DISCORD_BOT_TOKEN: "token",
      });

      expect(config.allowDm).toBe(false);
      expect(Array.from(config.allowedChannelIds)).toEqual(["111"]);
      expect(config.heartbeatCronTime).toBe(DEFAULT_HEARTBEAT_CRON_TIME);
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("config.toml の allow_dm が boolean でなければ失敗する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      `[discord]
allowed_channel_ids = ["111"]
allow_dm = "true"
`,
    );

    try {
      await expect(
        loadRuntimeConfig({
          LUNA_HOME: lunaHomeDir,
          DISCORD_BOT_TOKEN: "token",
        }),
      ).rejects.toThrowError(RuntimeConfigError);
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("config.toml の heartbeat.cron_time が不正値なら失敗する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      `[discord]
allowed_channel_ids = ["111"]

[heartbeat]
cron_time = "invalid-cron"
`,
    );

    try {
      await expect(
        loadRuntimeConfig({
          LUNA_HOME: lunaHomeDir,
          DISCORD_BOT_TOKEN: "token",
        }),
      ).rejects.toThrowError(RuntimeConfigError);
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("config.toml のトップレベル time_zone が不正値なら失敗する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      `time_zone = "Mars/Phobos"

[discord]
allowed_channel_ids = ["111"]

[heartbeat]
cron_time = "0 0,30 * * * *"
`,
    );

    try {
      await expect(
        loadRuntimeConfig({
          LUNA_HOME: lunaHomeDir,
          DISCORD_BOT_TOKEN: "token",
        }),
      ).rejects.toThrowError(RuntimeConfigError);
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("config.toml の heartbeat.time_zone は廃止のため失敗する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      `[discord]
allowed_channel_ids = ["111"]

[heartbeat]
cron_time = "0 0,30 * * * *"
time_zone = "UTC"
`,
    );

    try {
      await expect(
        loadRuntimeConfig({
          LUNA_HOME: lunaHomeDir,
          DISCORD_BOT_TOKEN: "token",
        }),
      ).rejects.toThrowError(RuntimeConfigError);
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("config.toml がファイル以外なら失敗する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await mkdir(resolve(lunaHomeDir, "config.toml"), {
      recursive: true,
    });

    try {
      await expect(
        loadRuntimeConfig({
          LUNA_HOME: lunaHomeDir,
          DISCORD_BOT_TOKEN: "token",
        }),
      ).rejects.toThrowError(RuntimeConfigError);
    } finally {
      await rm(lunaHomeDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it("DISCORD_BOT_TOKEN がなければ失敗する", async () => {
    const lunaHomeDir = createTempLunaHomeDir();
    await writeConfigToml(
      lunaHomeDir,
      createConfigToml({
        allowedChannelIds: ["111"],
      }),
    );

    await expect(
      loadRuntimeConfig({
        LUNA_HOME: lunaHomeDir,
      }),
    ).rejects.toThrowError(RuntimeConfigError);

    await rm(lunaHomeDir, {
      force: true,
      recursive: true,
    });
  });
});

function createTempLunaHomeDir(): string {
  return resolve(join(tmpdir(), `luna-runtime-config-${Date.now()}-${Math.random().toString(16)}`));
}

function createConfigToml(input: {
  allowedChannelIds: string[];
  allowDm?: boolean;
  heartbeat?: {
    cronTime: string;
  };
  timeZone?: string;
}): string {
  const channelIds = input.allowedChannelIds.map((channelId) => `"${channelId}"`).join(", ");
  const allowDm = input.allowDm ?? false;
  const heartbeat = input.heartbeat ?? {
    cronTime: DEFAULT_HEARTBEAT_CRON_TIME,
  };
  const timeZoneLine = input.timeZone === undefined ? "" : `time_zone = "${input.timeZone}"\n`;
  return (
    `${timeZoneLine}[discord]
allowed_channel_ids = [${channelIds}]
allow_dm = ${allowDm}

[heartbeat]
cron_time = "${heartbeat.cronTime}"
`.trimEnd() + "\n"
  );
}

async function writeConfigToml(lunaHomeDir: string, content: string): Promise<void> {
  await mkdir(lunaHomeDir, {
    recursive: true,
  });
  await writeFile(resolve(lunaHomeDir, "config.toml"), content);
}

async function createTempTemplatesDir(files: Record<string, string>): Promise<string> {
  const templatesDir = resolve(
    join(tmpdir(), `luna-runtime-config-templates-${Date.now()}-${Math.random().toString(16)}`),
  );
  await mkdir(templatesDir, {
    recursive: true,
  });
  await Promise.all(
    Object.entries(files).map(async ([fileName, content]) => {
      const filePath = resolve(templatesDir, fileName);
      await mkdir(dirname(filePath), {
        recursive: true,
      });
      await writeFile(filePath, content);
    }),
  );

  return templatesDir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
