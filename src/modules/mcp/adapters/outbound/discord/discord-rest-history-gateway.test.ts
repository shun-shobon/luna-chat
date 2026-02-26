import type { REST } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  createDiscordRestHistoryGateway,
  parseDiscordChannel,
  parseDiscordGuild,
  parseDiscordGuildMember,
  parseDiscordUser,
} from "./discord-rest-history-gateway";

describe("parseDiscordChannel", () => {
  it("チャンネル情報を正規化する", () => {
    expect(
      parseDiscordChannel({
        guild_id: "guild-1",
        id: "channel-1",
        name: "general",
        type: 0,
      }),
    ).toEqual({
      guildId: "guild-1",
      id: "channel-1",
      name: "general",
    });
  });

  it("不正な値は null を返す", () => {
    expect(parseDiscordChannel({ id: "channel-1" })).toBeNull();
  });
});

describe("parseDiscordGuild", () => {
  it("ギルド情報を正規化する", () => {
    expect(
      parseDiscordGuild({
        id: "guild-1",
        name: "Guild Name",
      }),
    ).toEqual({
      id: "guild-1",
      name: "Guild Name",
    });
  });
});

describe("parseDiscordUser", () => {
  it("ユーザー情報を正規化する", () => {
    expect(
      parseDiscordUser({
        avatar: null,
        banner: "banner",
        bot: true,
        global_name: "Global Name",
        id: "user-1",
        username: "user-name",
      }),
    ).toEqual({
      avatar: null,
      banner: "banner",
      bot: true,
      globalName: "Global Name",
      id: "user-1",
      username: "user-name",
    });
  });
});

describe("parseDiscordGuildMember", () => {
  it("メンバー情報を正規化する", () => {
    expect(
      parseDiscordGuildMember(
        {
          joined_at: "2026-01-01T00:00:00.000Z",
          nick: "nick-name",
          user: {
            id: "user-1",
            username: "username",
          },
        },
        "guild-1",
      ),
    ).toEqual({
      guildId: "guild-1",
      joinedAt: "2026-01-01T00:00:00.000Z",
      nickname: "nick-name",
      user: {
        avatar: null,
        banner: null,
        bot: false,
        globalName: null,
        id: "user-1",
        username: "username",
      },
    });
  });
});

describe("createDiscordRestHistoryGateway", () => {
  it("403/404 のときは null を返して継続する", async () => {
    const get: Pick<REST, "get">["get"] = vi.fn(async () => {
      throw {
        status: 403,
      };
    });
    const gateway = createDiscordRestHistoryGateway({ get });

    await expect(gateway.fetchChannelById("channel-1")).resolves.toBeNull();
    await expect(gateway.fetchGuildById("guild-1")).resolves.toBeNull();
    await expect(gateway.fetchUserById("user-1")).resolves.toBeNull();
    await expect(
      gateway.fetchGuildMemberByUserId({
        guildId: "guild-1",
        userId: "user-1",
      }),
    ).resolves.toBeNull();
  });

  it("403/404 以外のエラーは再送出する", async () => {
    const get: Pick<REST, "get">["get"] = vi.fn(async () => {
      throw new Error("boom");
    });
    const gateway = createDiscordRestHistoryGateway({ get });

    await expect(gateway.fetchUserById("user-1")).rejects.toThrow("boom");
  });
});
