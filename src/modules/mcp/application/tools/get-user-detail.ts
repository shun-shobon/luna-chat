import type { DiscordHistoryGateway } from "../../adapters/outbound/discord/discord-rest-history-gateway";

export async function getUserDetailTool(input: {
  allowedChannelIds: ReadonlySet<string>;
  channelId: string;
  gateway: DiscordHistoryGateway;
  userId: string;
}): Promise<{
  user: {
    avatar: string | null;
    banner: string | null;
    bot: boolean;
    displayName: string;
    globalName: string | null;
    id: string;
    nickname: string | null;
    username: string;
  } | null;
}> {
  const user = await input.gateway.fetchUserById(input.userId);
  if (!user) {
    return {
      user: null,
    };
  }

  let nickname: string | null = null;
  let displayName = user.globalName ?? user.username;

  if (!input.allowedChannelIds.has(input.channelId)) {
    return {
      user: {
        ...user,
        displayName,
        nickname,
      },
    };
  }

  const channel = await input.gateway.fetchChannelById(input.channelId);
  if (channel?.guildId) {
    const member = await input.gateway.fetchGuildMemberByUserId({
      guildId: channel.guildId,
      userId: input.userId,
    });
    if (member) {
      nickname = member.nickname;
      displayName =
        member.nickname ??
        member.user?.globalName ??
        member.user?.username ??
        user.globalName ??
        user.username;
    }
  }

  return {
    user: {
      ...user,
      displayName,
      nickname,
    },
  };
}
