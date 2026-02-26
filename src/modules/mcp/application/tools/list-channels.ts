import type { DiscordHistoryGateway } from "../../adapters/outbound/discord/discord-rest-history-gateway";

export async function listChannelsTool(input: {
  allowedChannelIds: ReadonlySet<string>;
  gateway: DiscordHistoryGateway;
}): Promise<{
  channels: Array<{
    guildId: string | null;
    guildName: string | null;
    id: string;
    name: string;
  }>;
}> {
  const channels: Array<{
    guildId: string | null;
    guildName: string | null;
    id: string;
    name: string;
  }> = [];
  const guildNameById = new Map<string, string | null>();

  for (const channelId of input.allowedChannelIds) {
    const channel = await input.gateway.fetchChannelById(channelId);
    if (!channel) {
      continue;
    }

    const guildId = channel.guildId;
    let guildName: string | null = null;
    if (guildId) {
      const cachedGuildName = guildNameById.get(guildId);
      if (cachedGuildName !== undefined) {
        guildName = cachedGuildName;
      } else {
        guildName = (await input.gateway.fetchGuildById(guildId))?.name ?? null;
        guildNameById.set(guildId, guildName);
      }
    }

    channels.push({
      guildId,
      guildName,
      id: channel.id,
      name: channel.name,
    });
  }

  return {
    channels,
  };
}
