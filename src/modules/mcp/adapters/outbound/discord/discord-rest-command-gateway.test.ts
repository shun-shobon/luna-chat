import { AttachmentBuilder, type MessageCreateOptions } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { createDiscordRestCommandGateway } from "./discord-rest-command-gateway";

describe("createDiscordRestCommandGateway", () => {
  it("channelId 指定時はそのまま解決する", async () => {
    const gateway = createDiscordRestCommandGateway(createClientStub());

    await expect(
      gateway.resolveChannelId({
        channelId: " channel-1 ",
      }),
    ).resolves.toBe("channel-1");
  });

  it("userId 指定時は DM チャンネルを作成して解決する", async () => {
    const client = createClientStub();
    const gateway = createDiscordRestCommandGateway(client);

    await expect(
      gateway.resolveChannelId({
        userId: " user-1 ",
      }),
    ).resolves.toBe("dm-channel-1");
    expect(client.users.createDM).toHaveBeenCalledWith("user-1");
  });

  it("空文字の userId はエラー", async () => {
    const gateway = createDiscordRestCommandGateway(createClientStub());

    await expect(
      gateway.resolveChannelId({
        userId: "   ",
      }),
    ).rejects.toThrow("userId must not be empty.");
  });

  it("通常メッセージを送信する", async () => {
    const client = createClientStub();
    const gateway = createDiscordRestCommandGateway(client);

    await expect(
      gateway.sendMessage({
        channelId: "channel-1",
        text: "  hello  ",
      }),
    ).resolves.toEqual({
      ok: true,
    });

    expect(client.channels.fetch).toHaveBeenCalledWith("channel-1");
    expect(client.channel.send).toHaveBeenCalledWith({
      content: "hello",
    });
  });

  it("本文なしで複数ファイルを送信する", async () => {
    const client = createClientStub();
    const gateway = createDiscordRestCommandGateway(client);

    await expect(
      gateway.sendMessage({
        channelId: "channel-1",
        filePaths: ["/tmp/report.txt", "/tmp/image.png"],
      }),
    ).resolves.toEqual({
      ok: true,
    });

    expect(client.channel.send).toHaveBeenCalledWith({
      files: [
        expect.objectContaining({
          attachment: "/tmp/report.txt",
          name: "report.txt",
        }),
        expect.objectContaining({
          attachment: "/tmp/image.png",
          name: "image.png",
        }),
      ],
    });
  });

  it("返信メッセージを送信する", async () => {
    const client = createClientStub();
    const gateway = createDiscordRestCommandGateway(client);

    await gateway.sendMessage({
      channelId: "channel-1",
      filePaths: ["/tmp/report.txt", "/tmp/image.png"],
      replyToMessageId: " reply-1 ",
      text: "hello",
    });

    expect(client.channel.send).toHaveBeenCalledWith({
      content: "hello",
      files: [
        expect.objectContaining({
          attachment: "/tmp/report.txt",
          name: "report.txt",
        }),
        expect.objectContaining({
          attachment: "/tmp/image.png",
          name: "image.png",
        }),
      ],
      reply: {
        failIfNotExists: false,
        messageReference: "reply-1",
      },
    });
  });

  it("text と filePaths の両方がない場合はエラー", async () => {
    const gateway = createDiscordRestCommandGateway(createClientStub());

    await expect(
      gateway.sendMessage({
        channelId: "channel-1",
      }),
    ).rejects.toThrow("text or filePaths must be provided.");
  });

  it("複数ファイルのみを添付送信する", async () => {
    const client = createClientStub();
    const gateway = createDiscordRestCommandGateway(client);

    await gateway.sendMessage({
      channelId: "channel-1",
      filePaths: ["/tmp/path/a.txt", "/tmp/other/b.png"],
    });

    expect(client.channel.send).toHaveBeenCalledTimes(1);
    const sentOptions = client.channel.send.mock.calls.at(0)?.at(0);
    if (!sentOptions) {
      throw new Error("send was not called");
    }
    expect(sentOptions).not.toHaveProperty("allowedMentions");
    expect(sentOptions).not.toHaveProperty("content");
    const attachments = sentOptions.files;
    expect(attachments).toHaveLength(2);
    const firstAttachment = attachments?.[0];
    const secondAttachment = attachments?.[1];
    expect(firstAttachment).toBeInstanceOf(AttachmentBuilder);
    expect(secondAttachment).toBeInstanceOf(AttachmentBuilder);
    if (
      !(firstAttachment instanceof AttachmentBuilder) ||
      !(secondAttachment instanceof AttachmentBuilder)
    ) {
      throw new Error("attachments were not built");
    }
    expect(firstAttachment.name).toBe("a.txt");
    expect(secondAttachment.name).toBe("b.png");
  });

  it("本文と返信と複数ファイルを同時に送信する", async () => {
    const client = createClientStub();
    const gateway = createDiscordRestCommandGateway(client);

    await gateway.sendMessage({
      channelId: "channel-1",
      filePaths: ["/tmp/path/a.txt", " /tmp/path/b.txt "],
      replyToMessageId: " reply-1 ",
      text: " hello ",
    });

    expect(client.channel.send).toHaveBeenCalledTimes(1);
    const sentOptions = client.channel.send.mock.calls.at(0)?.at(0);
    if (!sentOptions) {
      throw new Error("send was not called");
    }
    expect(sentOptions).toMatchObject({
      content: "hello",
      reply: {
        failIfNotExists: false,
        messageReference: "reply-1",
      },
    });
    const attachments = sentOptions.files;
    expect(attachments).toHaveLength(2);
    const firstAttachment = attachments?.[0];
    const secondAttachment = attachments?.[1];
    expect(firstAttachment).toBeInstanceOf(AttachmentBuilder);
    expect(secondAttachment).toBeInstanceOf(AttachmentBuilder);
    if (
      !(firstAttachment instanceof AttachmentBuilder) ||
      !(secondAttachment instanceof AttachmentBuilder)
    ) {
      throw new Error("attachments were not built");
    }
    expect(firstAttachment.name).toBe("a.txt");
    expect(secondAttachment.name).toBe("b.txt");
  });

  it("リアクションを付与する", async () => {
    const client = createClientStub();
    const gateway = createDiscordRestCommandGateway(client);

    await expect(
      gateway.addReaction({
        channelId: "channel-1",
        emoji: " 🎉 ",
        messageId: "message-1",
      }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(client.channel.messages.react).toHaveBeenCalledWith("message-1", "🎉");
  });

  it("typing を送信する", async () => {
    const client = createClientStub();
    const gateway = createDiscordRestCommandGateway(client);

    await gateway.sendTyping("channel-1");
    expect(client.channel.sendTyping).toHaveBeenCalledTimes(1);
  });
});

function createClientStub() {
  const channel = {
    isTextBased: () => true,
    messages: {
      react: vi.fn(async () => undefined),
    },
    send: vi.fn(async (_options: MessageCreateOptions) => undefined),
    sendTyping: vi.fn(async () => undefined),
  };
  return {
    channel,
    channels: {
      fetch: vi.fn(async () => channel),
    },
    users: {
      createDM: vi.fn(async () => ({
        id: "dm-channel-1",
      })),
    },
  };
}
