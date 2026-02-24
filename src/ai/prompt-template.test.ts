import { describe, expect, it } from "vitest";

import type { AiInput } from "./ai-service";
import { buildPromptBundle } from "./prompt-template";

describe("buildPromptBundle", () => {
  it("instructions/developer/user role prompt を分離して生成する", () => {
    const promptBundle = buildPromptBundle(createInput());

    expect(promptBundle.instructions).toContain("Discord Bot『ルナ』");
    expect(promptBundle.developerRolePrompt).toContain("メンション時は必ず返信する");
    expect(promptBundle.developerRolePrompt).toContain("send_discord_reply");
    expect(promptBundle.developerRolePrompt).not.toContain("fetch_discord_history");
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

  it("RUNBOOK 由来の文字列を含めない", () => {
    const promptBundle = buildPromptBundle(createInput());
    const merged = [
      promptBundle.instructions,
      promptBundle.developerRolePrompt,
      promptBundle.userRolePrompt,
    ].join("\n");

    expect(merged).not.toContain("RUNBOOK.md");
    expect(merged).not.toContain("operation rules:");
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
