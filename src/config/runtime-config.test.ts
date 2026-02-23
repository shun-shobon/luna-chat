import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadRuntimeConfig, RuntimeConfigError } from "./runtime-config";

describe("loadRuntimeConfig", () => {
  let workspaceDir = "";
  let apologyTemplatePath = "";

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "luna-chat-"));
    const templateDirectory = join(workspaceDir, "templates");
    mkdirSync(templateDirectory, { recursive: true });
    apologyTemplatePath = join(templateDirectory, "apology.md");
    writeFileSync(apologyTemplatePath, "ごめんね。少し待ってね。", "utf8");
  });

  afterEach(() => {
    rmSync(workspaceDir, { force: true, recursive: true });
  });

  it("必須設定を読み込む", () => {
    const config = loadRuntimeConfig({
      ALLOWED_CHANNEL_IDS: "111, 222,333",
      APOLOGY_TEMPLATE_PATH: apologyTemplatePath,
      CODEX_WORKSPACE_DIR: workspaceDir,
      CONTEXT_FETCH_LIMIT: "50",
      DISCORD_BOT_TOKEN: "token",
    });

    expect(config.discordBotToken).toBe("token");
    expect(Array.from(config.allowedChannelIds)).toEqual(["111", "222", "333"]);
    expect(config.contextFetchLimit).toBe(50);
    expect(config.codexAppServerCommand).toBe("codex app-server --listen stdio://");
    expect(config.codexWorkspaceDir).toBe(workspaceDir);
    expect(config.apologyTemplatePath).toBe(apologyTemplatePath);
    expect(config.codexAppServerModel).toBe("gpt-5.3-codex");
    expect(config.codexAppServerApprovalPolicy).toBe("never");
    expect(config.codexAppServerSandbox).toBe("workspace-write");
    expect(config.codexAppServerTimeoutMs).toBe(60_000);
    expect(config.codexAppServerCwd).toBe(process.cwd());
  });

  it("ALLOWED_CHANNEL_IDS が空なら失敗する", () => {
    expect(() =>
      loadRuntimeConfig({
        ALLOWED_CHANNEL_IDS: " ,  ",
        APOLOGY_TEMPLATE_PATH: apologyTemplatePath,
        CODEX_WORKSPACE_DIR: workspaceDir,
        DISCORD_BOT_TOKEN: "token",
      }),
    ).toThrowError(RuntimeConfigError);
  });

  it("DISCORD_BOT_TOKEN がなければ失敗する", () => {
    expect(() =>
      loadRuntimeConfig({
        ALLOWED_CHANNEL_IDS: "111",
        APOLOGY_TEMPLATE_PATH: apologyTemplatePath,
        CODEX_WORKSPACE_DIR: workspaceDir,
      }),
    ).toThrowError(RuntimeConfigError);
  });

  it("CONTEXT_FETCH_LIMIT が不正なら失敗する", () => {
    expect(() =>
      loadRuntimeConfig({
        ALLOWED_CHANNEL_IDS: "111",
        APOLOGY_TEMPLATE_PATH: apologyTemplatePath,
        CODEX_WORKSPACE_DIR: workspaceDir,
        CONTEXT_FETCH_LIMIT: "0",
        DISCORD_BOT_TOKEN: "token",
      }),
    ).toThrowError(RuntimeConfigError);
  });

  it("CODEX_APP_SERVER_TIMEOUT_MS が不正なら失敗する", () => {
    expect(() =>
      loadRuntimeConfig({
        ALLOWED_CHANNEL_IDS: "111",
        APOLOGY_TEMPLATE_PATH: apologyTemplatePath,
        CODEX_APP_SERVER_TIMEOUT_MS: "0",
        CODEX_WORKSPACE_DIR: workspaceDir,
        DISCORD_BOT_TOKEN: "token",
      }),
    ).toThrowError(RuntimeConfigError);
  });

  it("CODEX_APP_SERVER_SANDBOX が不正なら失敗する", () => {
    expect(() =>
      loadRuntimeConfig({
        ALLOWED_CHANNEL_IDS: "111",
        APOLOGY_TEMPLATE_PATH: apologyTemplatePath,
        CODEX_APP_SERVER_SANDBOX: "workspaceWrite",
        CODEX_WORKSPACE_DIR: workspaceDir,
        DISCORD_BOT_TOKEN: "token",
      }),
    ).toThrowError(RuntimeConfigError);
  });

  it("APOLOGY_TEMPLATE_PATH がワークスペース外なら失敗する", () => {
    const outsidePath = join(tmpdir(), "outside-apology.md");
    writeFileSync(outsidePath, "outside", "utf8");

    expect(() =>
      loadRuntimeConfig({
        ALLOWED_CHANNEL_IDS: "111",
        APOLOGY_TEMPLATE_PATH: outsidePath,
        CODEX_WORKSPACE_DIR: workspaceDir,
        DISCORD_BOT_TOKEN: "token",
      }),
    ).toThrowError(RuntimeConfigError);
    rmSync(outsidePath, { force: true });
  });
});
