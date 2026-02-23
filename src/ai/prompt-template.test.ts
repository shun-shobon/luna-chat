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
    expect(promptBundle.userRolePrompt).toContain("テスト本文");
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
    contextFetchLimit: 30,
    currentMessage: {
      authorId: "author-id",
      authorName: "author-name",
      channelId: "channel-id",
      content: "テスト本文",
      createdAt: "2026-02-23T00:00:00.000Z",
      id: "message-id",
      mentionedBot: false,
    },
    forceReply: false,
  };
}
