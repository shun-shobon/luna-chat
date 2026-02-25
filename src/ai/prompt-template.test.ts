import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { AiInput } from "./ai-service";
import { buildPromptBundle } from "./prompt-template";

describe("buildPromptBundle", () => {
  it("instructions/developer/user role prompt を分離して生成する", async () => {
    await withWorkspaceDir(async (workspaceDir) => {
      const promptBundle = await buildPromptBundle(createInput(), workspaceDir);

      expect(promptBundle.instructions).toContain("Discord Bot『ルナ』");
      expect(promptBundle.developerRolePrompt).toContain("メンション時は必ず返信する");
      expect(promptBundle.developerRolePrompt).toContain("send_message");
      expect(promptBundle.developerRolePrompt).not.toContain("read_message_history");
      expect(promptBundle.userRolePrompt).toContain("currentMessage:");
      expect(promptBundle.userRolePrompt).toContain("channelName: channel-name");
      expect(promptBundle.userRolePrompt).toContain("recentMessages:");
      expect(promptBundle.userRolePrompt).toContain("テスト本文");
      expect(promptBundle.userRolePrompt).not.toContain("contextFetchLimit:");
      expect(promptBundle.userRolePrompt).not.toContain("currentMessageId:");

      const recentMessagesIndex = promptBundle.userRolePrompt.indexOf("recentMessages:");
      const currentMessageIndex = promptBundle.userRolePrompt.indexOf("currentMessage:");
      expect(recentMessagesIndex).toBeGreaterThanOrEqual(0);
      expect(currentMessageIndex).toBeGreaterThan(recentMessagesIndex);
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
        "口調は優しい少女で、敬語とため口を自然に混ぜる。",
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

      expect(promptBundle.instructions).toContain("Discord Bot『ルナ』");
      expect(promptBundle.instructions).toContain("SOUL の追加指示");
    });
  });
});

function createInput(): AiInput {
  return {
    channelName: "channel-name",
    currentMessage: {
      authorId: "author-id",
      authorName: "author-name",
      channelId: "channel-id",
      content: "テスト本文",
      createdAt: "2026-02-23 09:00:00 JST",
      id: "message-id",
      mentionedBot: false,
    },
    forceReply: false,
    recentMessages: [
      {
        authorId: "recent-author-id",
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
