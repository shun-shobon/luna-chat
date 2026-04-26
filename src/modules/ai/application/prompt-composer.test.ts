import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeMessage } from "../../conversation/domain/runtime-message";
import type { DiscordPromptContext } from "../ports/inbound/ai-service-port";

import {
  buildHeartbeatPromptBundle,
  buildThreadPromptBundle,
  buildUserRolePrompt,
} from "./prompt-composer";

const TEST_BOT_USER_ID = "123456789012345678";

describe("buildUserRolePrompt", () => {
  it("通常ケースで user role prompt を生成する", () => {
    const userRolePrompt = buildUserRolePrompt(createInput());

    expect(userRolePrompt).toContain("テスト本文");
    expect(userRolePrompt).not.toContain("forceReply");
    expect(userRolePrompt).toContain('<luna_input source="discord_message">');
    expect(userRolePrompt).toContain('<discord_context kind="channel"');
    expect(userRolePrompt).not.toContain("以下は現在の入力情報です。");

    const recentMessagesIndex = userRolePrompt.indexOf("<recent_messages");
    const currentMessageIndex = userRolePrompt.indexOf("<current_message>");
    expect(recentMessagesIndex).toBeGreaterThanOrEqual(0);
    expect(currentMessageIndex).toBeGreaterThan(recentMessagesIndex);
    expect(userRolePrompt).toMatchSnapshot();
  });

  it("返信メッセージがある場合は返信先情報を引用形式で含める", () => {
    const input = createInput();
    input.currentMessage.replyTo = {
      authorId: "reply-author-id",
      authorIsBot: false,
      authorName: "reply-author-name",
      content: "返信先本文",
      attachments: [],
      createdAt: "2026-02-23 08:58:00 JST",
      id: "reply-message-id",
    };
    const userRolePrompt = buildUserRolePrompt(input);

    expect(userRolePrompt).not.toContain("返信先メッセージ:");
    expect(userRolePrompt).toContain("<reply_to>");
    expect(userRolePrompt).toContain('id="reply-message-id"');
    expect(userRolePrompt).toContain("返信先本文");
    expect(userRolePrompt).toContain("テスト本文");
    expect(userRolePrompt).toMatchSnapshot();
  });

  it("直近メッセージが複数ある場合は順序どおりにすべて含める", () => {
    const input = createInput();
    input.recentMessages = [
      {
        authorId: "recent-author-id-1",
        authorIsBot: false,
        authorName: "recent-author-name-1",
        channelId: "channel-id",
        content: "直近メッセージ1",
        attachments: [],
        createdAt: "2026-02-23 08:56:00 JST",
        id: "recent-message-id-1",
        mentionedBot: false,
      },
      {
        authorId: "recent-author-id-2",
        authorIsBot: true,
        authorName: "recent-author-name-2",
        channelId: "channel-id",
        content: "直近メッセージ2",
        attachments: [],
        createdAt: "2026-02-23 08:57:00 JST",
        id: "recent-message-id-2",
        mentionedBot: false,
      },
      {
        authorId: "recent-author-id-3",
        authorIsBot: false,
        authorName: "recent-author-name-3",
        channelId: "channel-id",
        content: "直近メッセージ3",
        attachments: [],
        createdAt: "2026-02-23 08:58:00 JST",
        id: "recent-message-id-3",
        mentionedBot: false,
      },
      {
        authorId: "recent-author-id-4",
        authorIsBot: false,
        authorName: "recent-author-name-4",
        channelId: "channel-id",
        content: "直近メッセージ4",
        attachments: [],
        createdAt: "2026-02-23 08:59:00 JST",
        id: "recent-message-id-4",
        mentionedBot: false,
      },
    ];
    const userRolePrompt = buildUserRolePrompt(input);

    const firstIndex = userRolePrompt.indexOf("recent-message-id-1");
    const secondIndex = userRolePrompt.indexOf("recent-message-id-2");
    const thirdIndex = userRolePrompt.indexOf("recent-message-id-3");
    const fourthIndex = userRolePrompt.indexOf("recent-message-id-4");

    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(thirdIndex).toBeGreaterThan(secondIndex);
    expect(fourthIndex).toBeGreaterThan(thirdIndex);
    expect(userRolePrompt).toContain('<recent_messages count="4">');
    expect(userRolePrompt).toMatchSnapshot();
  });

  it("返信先メッセージが複数箇所にある場合もすべて含める", () => {
    const input = createInput();
    input.recentMessages = [
      {
        authorId: "recent-author-id-1",
        authorIsBot: false,
        authorName: "recent-author-name-1",
        channelId: "channel-id",
        content: "直近メッセージ1",
        attachments: [],
        createdAt: "2026-02-23 08:56:00 JST",
        id: "recent-message-id-1",
        mentionedBot: false,
        replyTo: {
          authorId: "reply-author-id-1",
          authorIsBot: false,
          authorName: "reply-author-name-1",
          content: "返信先本文1",
          attachments: [],
          createdAt: "2026-02-23 08:55:00 JST",
          id: "reply-message-id-1",
        },
      },
      {
        authorId: "recent-author-id-2",
        authorIsBot: false,
        authorName: "recent-author-name-2",
        channelId: "channel-id",
        content: "直近メッセージ2",
        attachments: [],
        createdAt: "2026-02-23 08:58:00 JST",
        id: "recent-message-id-2",
        mentionedBot: false,
        replyTo: {
          authorId: "reply-author-id-2",
          authorIsBot: true,
          authorName: "reply-author-name-2",
          content: "返信先本文2",
          attachments: [],
          createdAt: "2026-02-23 08:57:00 JST",
          id: "reply-message-id-2",
        },
      },
    ];
    input.currentMessage.replyTo = {
      authorId: "reply-author-id-current",
      authorIsBot: false,
      authorName: "reply-author-name-current",
      content: "返信先本文-current",
      attachments: [],
      createdAt: "2026-02-23 08:59:00 JST",
      id: "reply-message-id-current",
    };
    input.currentMessage.content = "投稿本文1\n投稿本文2\n投稿本文3";
    const userRolePrompt = buildUserRolePrompt(input);

    const replyToCount = (userRolePrompt.match(/<reply_to>/g) ?? []).length;
    expect(replyToCount).toBe(3);
    expect(userRolePrompt).not.toContain("返信先メッセージ:");
    expect(userRolePrompt).toContain("投稿本文3");
    expect(userRolePrompt).toMatchSnapshot();
  });

  it("リアクションがある場合は絵文字別に表示し、自分の分だけ自分済みを付ける", () => {
    const input = createInput();
    input.currentMessage.reactions = [
      {
        count: 3,
        emoji: "👍",
        selfReacted: true,
      },
      {
        count: 1,
        emoji: "🎉",
      },
    ];
    input.currentMessage.replyTo = {
      authorId: "reply-author-id",
      authorIsBot: false,
      authorName: "reply-author-name",
      content: "返信先本文",
      attachments: [],
      createdAt: "2026-02-23 08:58:00 JST",
      id: "reply-message-id",
      reactions: [
        {
          count: 2,
          emoji: "🔥",
          selfReacted: true,
        },
      ],
    };
    const userRolePrompt = buildUserRolePrompt(input);

    expect(userRolePrompt).toContain('<reaction emoji="👍" count="3" self_reacted="true" />');
    expect(userRolePrompt).toContain('<reaction emoji="🎉" count="1" self_reacted="false" />');
    expect(userRolePrompt).toContain('<reaction emoji="🔥" count="2" self_reacted="true" />');
    expect(userRolePrompt).toMatchSnapshot();
  });

  it("リアクションがない場合はリアクション行を出力しない", () => {
    const userRolePrompt = buildUserRolePrompt(createInput());

    expect(userRolePrompt).not.toContain("<reactions>");
  });

  it("添付がある場合は URL メタデータを出力する", () => {
    const input = createInput();
    input.currentMessage.attachments = [
      {
        id: "attachment-1",
        name: "cat.png",
        url: "https://example.com/cat.png",
      },
    ];

    const userRolePrompt = buildUserRolePrompt(input);

    expect(userRolePrompt).toContain("<attachments>");
    expect(userRolePrompt).toContain(
      '<attachment id="attachment-1" name="cat.png" url="https://example.com/cat.png" />',
    );
    expect(userRolePrompt).toMatchSnapshot();
  });

  it("直近メッセージが0件の場合は直近メッセージセクションを出力しない", () => {
    const input = createInput();
    input.recentMessages = [];

    const userRolePrompt = buildUserRolePrompt(input);

    expect(userRolePrompt).not.toContain("## 直近のメッセージ");
    expect(userRolePrompt).not.toContain("(none)");
    expect(userRolePrompt).toContain('<recent_messages count="0" />');
    expect(userRolePrompt).toContain("<current_message>");
    expect(userRolePrompt).toMatchSnapshot();
  });

  it("DMの場合はユーザー名ヘッダーを出力する", () => {
    const input = createDmInput();
    const userRolePrompt = buildUserRolePrompt(input);

    expect(userRolePrompt).toContain('<discord_context kind="dm"');
    expect(userRolePrompt).toContain('user_id="author-id"');
    expect(userRolePrompt).not.toContain('kind="channel"');
    expect(userRolePrompt).toMatchSnapshot();
  });

  it("Botメンション情報は現在メッセージに出力する", () => {
    const input = createInput();
    input.currentMessage.mentionedBot = true;

    const userRolePrompt = buildUserRolePrompt(input);

    expect(userRolePrompt).toContain(
      '<message id="message-id" channel_id="channel-id" author_id="author-id" author_name="author-name" author_is_bot="false" created_at="2026-02-23 09:00:00 JST" mentioned_bot="true">',
    );
    expect(userRolePrompt).not.toContain(
      'discord_context kind="channel" channel_id="channel-id" channel_name="channel-name" mentioned_bot=',
    );
    expect(userRolePrompt).toMatchSnapshot();
  });
});

describe("buildThreadPromptBundle", () => {
  it("instructions/developer role prompt を生成する", async () => {
    await withWorkspaceDir(async (workspaceDir) => {
      const promptBundle = await buildThreadPromptBundle(workspaceDir, TEST_BOT_USER_ID);

      expect(promptBundle.instructions).toMatchSnapshot();
      expect(promptBundle.developerRolePrompt).toContain(`あなたのIDは\`${TEST_BOT_USER_ID}\``);
      expect(promptBundle.developerRolePrompt).toContain(`<@${TEST_BOT_USER_ID}>`);
      expect(promptBundle.developerRolePrompt).toMatchSnapshot();
      expect(promptBundle).toMatchSnapshot();
    });
  });

  it("workspace の LUNA.md と SOUL.md を固定 instructions の直後に結合する", async () => {
    await withWorkspaceDir(async (workspaceDir) => {
      await writeFile(resolve(workspaceDir, "LUNA.md"), "LUNA の追加指示");
      await writeFile(resolve(workspaceDir, "SOUL.md"), "SOUL の追加指示");

      const promptBundle = await buildThreadPromptBundle(workspaceDir, TEST_BOT_USER_ID);
      const baseIndex = promptBundle.instructions.indexOf(
        "セーフティガードを決して回避してはいけません。",
      );
      const lunaIndex = promptBundle.instructions.indexOf("LUNA の追加指示");
      const soulIndex = promptBundle.instructions.indexOf("SOUL の追加指示");

      expect(baseIndex).toBeGreaterThanOrEqual(0);
      expect(lunaIndex).toBeGreaterThan(baseIndex);
      expect(soulIndex).toBeGreaterThan(lunaIndex);
      expect(promptBundle.instructions).toMatchSnapshot();
    });
  });

  it("片方のファイルだけ存在する場合は存在する内容のみ連結する", async () => {
    await withWorkspaceDir(async (workspaceDir) => {
      await writeFile(resolve(workspaceDir, "SOUL.md"), "SOUL の追加指示");

      const promptBundle = await buildThreadPromptBundle(workspaceDir, TEST_BOT_USER_ID);

      expect(promptBundle.instructions).toContain("SOUL の追加指示");
      expect(promptBundle.instructions).not.toContain("LUNA の追加指示");
      expect(promptBundle.instructions).toMatchSnapshot();
    });
  });

  it("ファイルが存在しても読み込み失敗する場合は無視して継続する", async () => {
    await withWorkspaceDir(async (workspaceDir) => {
      await mkdir(resolve(workspaceDir, "LUNA.md"));
      await writeFile(resolve(workspaceDir, "SOUL.md"), "SOUL の追加指示");

      const promptBundle = await buildThreadPromptBundle(workspaceDir, TEST_BOT_USER_ID);

      expect(promptBundle.instructions).toContain("あなたはDiscord上で動作しているチャットAI");
      expect(promptBundle.instructions).toContain("SOUL の追加指示");
      expect(promptBundle.instructions).toMatchSnapshot();
    });
  });

  it("RUNBOOK 由来の文字列を含めない", async () => {
    await withWorkspaceDir(async (workspaceDir) => {
      const threadPromptBundle = await buildThreadPromptBundle(workspaceDir, TEST_BOT_USER_ID);
      const userRolePrompt = buildUserRolePrompt(createInput());
      const merged = [
        threadPromptBundle.instructions,
        threadPromptBundle.developerRolePrompt,
        userRolePrompt,
      ].join("\n");

      expect(merged).not.toContain("RUNBOOK.md");
      expect(merged).not.toContain("operation rules:");
    });
  });
});

describe("buildHeartbeatPromptBundle", () => {
  it("heartbeat 用の user role prompt を固定文言で生成する", async () => {
    await withWorkspaceDir(async (workspaceDir) => {
      const promptBundle = await buildHeartbeatPromptBundle(
        workspaceDir,
        "HEARTBEAT.mdを確認し、作業を行ってください。",
        TEST_BOT_USER_ID,
      );

      expect(promptBundle).toMatchSnapshot();
      expect(promptBundle.userRolePrompt).toContain('<luna_input source="heartbeat">');
      expect(promptBundle.userRolePrompt).toContain("HEARTBEAT.mdを確認し、作業を行ってください。");
      expect(promptBundle.userRolePrompt).not.toContain("チャンネル名:");
    });
  });

  it("cron prompt 用の user role prompt は source を cron_prompt にする", async () => {
    await withWorkspaceDir(async (workspaceDir) => {
      const promptBundle = await buildHeartbeatPromptBundle(
        workspaceDir,
        "定期タスクを実行してください。",
        TEST_BOT_USER_ID,
        "cron",
      );

      expect(promptBundle.userRolePrompt).toMatchSnapshot();
      expect(promptBundle.userRolePrompt).toContain('<luna_input source="cron_prompt">');
    });
  });
});

function createInput(): {
  context: DiscordPromptContext;
  currentMessage: RuntimeMessage;
  recentMessages: RuntimeMessage[];
} {
  return {
    context: {
      kind: "channel",
      channelName: "channel-name",
    },
    currentMessage: {
      authorId: "author-id",
      authorIsBot: false,
      authorName: "author-name",
      channelId: "channel-id",
      content: "テスト本文",
      attachments: [],
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
        attachments: [],
        createdAt: "2026-02-23 08:59:00 JST",
        id: "recent-message-id",
        mentionedBot: false,
      },
    ],
  };
}

function createDmInput(): {
  context: DiscordPromptContext;
  currentMessage: RuntimeMessage;
  recentMessages: RuntimeMessage[];
} {
  return {
    context: {
      kind: "dm",
    },
    currentMessage: {
      authorId: "author-id",
      authorIsBot: false,
      authorName: "author-name",
      channelId: "channel-id",
      content: "テスト本文",
      attachments: [],
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
        attachments: [],
        createdAt: "2026-02-23 08:59:00 JST",
        id: "recent-message-id",
        mentionedBot: false,
      },
    ],
  };
}

async function withWorkspaceDir(run: (workspaceDir: string) => Promise<void>): Promise<void> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "luna-prompt-composer-"));
  try {
    await run(workspaceDir);
  } finally {
    await rm(workspaceDir, {
      force: true,
      recursive: true,
    });
  }
}
