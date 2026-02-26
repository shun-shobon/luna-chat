import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { AiInput } from "./ai-service";
import { buildHeartbeatPromptBundle, buildPromptBundle } from "./prompt-template";

describe("buildPromptBundle", () => {
  it("instructions/developer/user role prompt を分離して生成する", async () => {
    await withWorkspaceDir(async (workspaceDir) => {
      const promptBundle = await buildPromptBundle(createInput(), workspaceDir);

      expect(promptBundle.instructions).toContain(
        "あなたはLunaで動作しているパーソナルアシスタントです。",
      );
      expect(promptBundle.developerRolePrompt).toContain("`discord`ツール");
      expect(promptBundle.developerRolePrompt).toContain("`start_typing`");
      expect(promptBundle.userRolePrompt).toContain("チャンネル名: channel-name (ID: channel-id)");
      expect(promptBundle.userRolePrompt).toContain("直近のメッセージ:");
      expect(promptBundle.userRolePrompt).toContain("投稿されたメッセージ:");
      expect(promptBundle.userRolePrompt).toContain(
        "[2026-02-23 08:59:00 JST] recent-author-name (Bot) (ID: recent-author-id) (Message ID: recent-message-id): 直近メッセージ",
      );
      expect(promptBundle.userRolePrompt).toContain(
        "[2026-02-23 09:00:00 JST] author-name (ID: author-id) (Message ID: message-id): テスト本文",
      );
      expect(promptBundle.userRolePrompt).toContain("テスト本文");
      expect(promptBundle.userRolePrompt).not.toContain("forceReply");

      const recentMessagesIndex = promptBundle.userRolePrompt.indexOf("直近のメッセージ:");
      const currentMessageIndex = promptBundle.userRolePrompt.indexOf("投稿されたメッセージ:");
      expect(recentMessagesIndex).toBeGreaterThanOrEqual(0);
      expect(currentMessageIndex).toBeGreaterThan(recentMessagesIndex);
    });
  });

  it("返信メッセージがある場合は返信先情報を既存フォーマットで含める", async () => {
    await withWorkspaceDir(async (workspaceDir) => {
      const input = createInput();
      input.currentMessage.replyTo = {
        authorId: "reply-author-id",
        authorIsBot: false,
        authorName: "reply-author-name",
        content: "返信先本文",
        createdAt: "2026-02-23 08:58:00 JST",
        id: "reply-message-id",
      };
      const promptBundle = await buildPromptBundle(input, workspaceDir);

      expect(promptBundle.userRolePrompt).toContain("返信先メッセージ:");
      expect(promptBundle.userRolePrompt).toContain(
        "[2026-02-23 08:58:00 JST] reply-author-name (ID: reply-author-id) (Message ID: reply-message-id): 返信先本文",
      );
      expect(promptBundle.userRolePrompt).toContain(
        "[2026-02-23 09:00:00 JST] author-name (ID: author-id) (Message ID: message-id): テスト本文",
      );
    });
  });

  it("RUNBOOK 由来の文字列を含めない", async () => {
    await withWorkspaceDir(async (workspaceDir) => {
      const promptBundle = await buildPromptBundle(createInput(), workspaceDir);
      const merged = [
        promptBundle.instructions,
        promptBundle.developerRolePrompt,
        promptBundle.userRolePrompt,
      ].join("\n");

      expect(merged).not.toContain("RUNBOOK.md");
      expect(merged).not.toContain("operation rules:");
    });
  });

  it("workspace の LUNA.md と SOUL.md を固定 instructions の直後に結合する", async () => {
    await withWorkspaceDir(async (workspaceDir) => {
      await writeFile(resolve(workspaceDir, "LUNA.md"), "LUNA の追加指示");
      await writeFile(resolve(workspaceDir, "SOUL.md"), "SOUL の追加指示");

      const promptBundle = await buildPromptBundle(createInput(), workspaceDir);
      const baseIndex = promptBundle.instructions.indexOf(
        "セーフティガードを決して回避してはいけません。",
      );
      const lunaIndex = promptBundle.instructions.indexOf("LUNA の追加指示");
      const soulIndex = promptBundle.instructions.indexOf("SOUL の追加指示");

      expect(baseIndex).toBeGreaterThanOrEqual(0);
      expect(lunaIndex).toBeGreaterThan(baseIndex);
      expect(soulIndex).toBeGreaterThan(lunaIndex);
    });
  });

  it("片方のファイルだけ存在する場合は存在する内容のみ連結する", async () => {
    await withWorkspaceDir(async (workspaceDir) => {
      await writeFile(resolve(workspaceDir, "SOUL.md"), "SOUL の追加指示");

      const promptBundle = await buildPromptBundle(createInput(), workspaceDir);

      expect(promptBundle.instructions).toContain("SOUL の追加指示");
      expect(promptBundle.instructions).not.toContain("LUNA の追加指示");
    });
  });

  it("ファイルが存在しても読み込み失敗する場合は無視して継続する", async () => {
    await withWorkspaceDir(async (workspaceDir) => {
      await mkdir(resolve(workspaceDir, "LUNA.md"));
      await writeFile(resolve(workspaceDir, "SOUL.md"), "SOUL の追加指示");

      const promptBundle = await buildPromptBundle(createInput(), workspaceDir);

      expect(promptBundle.instructions).toContain(
        "あなたはLunaで動作しているパーソナルアシスタント",
      );
      expect(promptBundle.instructions).toContain("SOUL の追加指示");
    });
  });
});

describe("buildHeartbeatPromptBundle", () => {
  it("heartbeat 用の user role prompt を固定文言で生成する", async () => {
    await withWorkspaceDir(async (workspaceDir) => {
      const promptBundle = await buildHeartbeatPromptBundle(
        workspaceDir,
        "HEARTBEAT.mdを確認し、作業を行ってください。",
      );

      expect(promptBundle.instructions).toContain(
        "あなたはLunaで動作しているパーソナルアシスタントです。",
      );
      expect(promptBundle.developerRolePrompt).toContain("`discord`ツール");
      expect(promptBundle.developerRolePrompt).toContain("`start_typing`");
      expect(promptBundle.userRolePrompt).toBe("HEARTBEAT.mdを確認し、作業を行ってください。");
      expect(promptBundle.userRolePrompt).not.toContain("チャンネル名:");
    });
  });
});

function createInput(): AiInput {
  return {
    channelName: "channel-name",
    currentMessage: {
      authorId: "author-id",
      authorIsBot: false,
      authorName: "author-name",
      channelId: "channel-id",
      content: "テスト本文",
      createdAt: "2026-02-23 09:00:00 JST",
      id: "message-id",
      mentionedBot: false,
    },
    recentMessages: [
      {
        authorId: "recent-author-id",
        authorIsBot: true,
        authorName: "recent-author-name",
        channelId: "channel-id",
        content: "直近メッセージ",
        createdAt: "2026-02-23 08:59:00 JST",
        id: "recent-message-id",
        mentionedBot: false,
      },
    ],
  };
}

async function withWorkspaceDir(run: (workspaceDir: string) => Promise<void>): Promise<void> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "luna-prompt-template-"));
  try {
    await run(workspaceDir);
  } finally {
    await rm(workspaceDir, {
      force: true,
      recursive: true,
    });
  }
}
