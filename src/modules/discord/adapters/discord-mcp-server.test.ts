import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiscordActionPort } from "../ports/discord-action-port";
import type { DiscordReadPort } from "../ports/discord-read-port";

import {
  DISCORD_MCP_TYPING_OWNER_HEADER,
  startDiscordMcpServer,
  type DiscordMcpServerHandle,
} from "./discord-mcp-server";

const resources: Array<{ client: McpClient; server: DiscordMcpServerHandle }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.client.close();
    await resource.server.close();
  }
});

describe("Discord MCP server", () => {
  it("loopback random portで5 read toolと全write action toolを公開する", async () => {
    const actions = createActionPort();
    const read = createReadPort();
    const resource = await connect({ actions, read });

    const tools = await resource.client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "add_reaction",
      "get_guild_emoji",
      "get_user_detail",
      "list_channels",
      "list_guild_emojis",
      "read_message_history",
      "remove_reaction",
      "reply_message",
      "send_message",
      "start_typing",
      "stop_typing",
    ]);
    const url = new URL(resource.server.url);
    expect(url.hostname).toBe("127.0.0.1");
    expect(Number(url.port)).toBeGreaterThan(0);
    expect(url.pathname).toBe("/mcp");
  });

  it("read toolを対応portへそのまま委譲する", async () => {
    const read = createReadPort();
    const resource = await connect({ actions: createActionPort(), read });

    await resource.client.callTool({
      name: "read_message_history",
      arguments: { channelId: "300", limit: 10, beforeMessageId: "100" },
    });
    await resource.client.callTool({ name: "list_channels", arguments: {} });
    await resource.client.callTool({
      name: "get_user_detail",
      arguments: { userId: "400", guildId: "200" },
    });
    await resource.client.callTool({
      name: "list_guild_emojis",
      arguments: { guildId: "200" },
    });
    await resource.client.callTool({
      name: "get_guild_emoji",
      arguments: { guildId: "200", emojiId: "500" },
    });

    expect(read.readMessageHistory).toHaveBeenCalledWith({
      channelId: "300",
      limit: 10,
      beforeMessageId: "100",
    });
    expect(read.listChannels).toHaveBeenCalledOnce();
    expect(read.getUserDetail).toHaveBeenCalledWith({ userId: "400", guildId: "200" });
    expect(read.listGuildEmojis).toHaveBeenCalledWith("200");
    expect(read.getGuildEmoji).toHaveBeenCalledWith({ guildId: "200", emojiId: "500" });
  });

  it("toolCallId付きeventへtool引数と結果を渡す", async () => {
    const onEvent = vi.fn();
    const resource = await connect({
      actions: createActionPort(),
      onEvent,
      read: createReadPort(),
    });

    await resource.client.callTool({ name: "get_user_detail", arguments: { userId: "400" } });

    expect(onEvent).toHaveBeenCalledWith(
      "discord.mcp_tool_started",
      expect.objectContaining({ toolCallId: expect.any(String) }),
      { toolName: "get_user_detail" },
      { userId: "400" },
    );
    expect(onEvent).toHaveBeenCalledWith(
      "discord.mcp_tool_completed",
      expect.objectContaining({ toolCallId: expect.any(String) }),
      { toolName: "get_user_detail" },
      expect.any(Object),
    );
  });

  it("各write toolをstrictなDiscordActionへ変換しowner付きで即時実行する", async () => {
    const actions = createActionPort();
    const resource = await connect({ actions, read: createReadPort() });

    await resource.client.callTool({
      name: "send_message",
      arguments: {
        target: { kind: "channel", channelId: "300" },
        content: "hello",
      },
    });
    await resource.client.callTool({
      name: "reply_message",
      arguments: { channelId: "300", messageId: "100", content: "reply" },
    });
    await resource.client.callTool({
      name: "add_reaction",
      arguments: {
        channelId: "300",
        messageId: "100",
        emoji: { kind: "unicode", value: "🌙" },
      },
    });
    await resource.client.callTool({
      name: "remove_reaction",
      arguments: {
        channelId: "300",
        messageId: "100",
        emoji: { kind: "custom", id: "500", name: "luna" },
      },
    });
    await resource.client.callTool({
      name: "start_typing",
      arguments: { target: { kind: "dm_user", userId: "400" } },
    });
    await resource.client.callTool({
      name: "stop_typing",
      arguments: { target: { kind: "dm_user", userId: "400" } },
    });

    expect(actions.execute).toHaveBeenCalledTimes(6);
    expect(actions.execute.mock.calls.map((call) => call[0].kind)).toEqual([
      "send_message",
      "reply_message",
      "add_reaction",
      "remove_reaction",
      "start_typing",
      "stop_typing",
    ]);
    expect(actions.execute.mock.calls.every((call) => call[1] === "turn-owner")).toBe(true);
  });

  it("未知fieldや不完全なmessage actionをport実行前に拒否する", async () => {
    const actions = createActionPort();
    const resource = await connect({ actions, read: createReadPort() });

    const response = await resource.client.callTool({
      name: "send_message",
      arguments: { target: { kind: "channel", channelId: "300" }, unexpected: true },
    });

    expect(response.isError).toBe(true);
    expect(actions.execute).not.toHaveBeenCalled();
  });

  it("typing owner header欠落時はwrite toolだけを失敗させる", async () => {
    const actions = createActionPort();
    const resource = await connect({ actions, read: createReadPort() }, null);

    const response = await resource.client.callTool({
      name: "start_typing",
      arguments: { target: { kind: "channel", channelId: "300" } },
    });

    expect(response.isError).toBe(true);
    expect(actions.execute).not.toHaveBeenCalled();
  });
});

async function connect(
  input: {
    actions: DiscordActionPort;
    onEvent?: (
      event: string,
      context: Readonly<{ actionIndex?: number; toolCallId: string }>,
      details: Readonly<Record<string, unknown>>,
      payload?: unknown,
    ) => void;
    read: DiscordReadPort;
  },
  ownerId: string | null = "turn-owner",
) {
  const server = await startDiscordMcpServer({
    actions: input.actions,
    onError: vi.fn(),
    onEvent: input.onEvent ?? vi.fn(),
    read: input.read,
  });
  const client = new McpClient({ name: "discord-mcp-contract", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit:
        ownerId === null ? {} : { headers: { [DISCORD_MCP_TYPING_OWNER_HEADER]: ownerId } },
    }),
  );
  const resource = { client, server };
  resources.push(resource);
  return resource;
}

function createActionPort() {
  return {
    execute: vi.fn<DiscordActionPort["execute"]>(async (action) => ({
      actionKind: action.kind,
    })),
    releaseTyping: vi.fn(async () => undefined),
  };
}

function createReadPort() {
  return {
    readMessageHistory: vi.fn<DiscordReadPort["readMessageHistory"]>(async () => []),
    listChannels: vi.fn<DiscordReadPort["listChannels"]>(async () => []),
    getUserDetail: vi.fn<DiscordReadPort["getUserDetail"]>(async ({ userId }) => ({
      id: userId,
      username: "shun",
      globalName: null,
      bot: false,
      system: false,
      avatarUrl: null,
      bannerUrl: null,
    })),
    listGuildEmojis: vi.fn<DiscordReadPort["listGuildEmojis"]>(async () => []),
    getGuildEmoji: vi.fn<DiscordReadPort["getGuildEmoji"]>(async ({ guildId, emojiId }) => ({
      id: emojiId,
      guildId,
      name: "luna",
      animated: false,
      available: true,
      mention: `<:luna:${emojiId}>`,
      url: `https://cdn.discordapp.com/emojis/${emojiId}.webp`,
    })),
  };
}
