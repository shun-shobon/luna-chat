import type { DiscordMessage } from "../domain/discord-message";
import { discordMessageSchema } from "../domain/discord-message";

export type DiscordMessageSource = Readonly<{
  id: string;
  timestamp: Date;
  system: boolean;
  guild: Readonly<{ id: string; name: string }> | null;
  channel: Readonly<{ id: string; name: string | null }>;
  author: Readonly<{
    id: string;
    username: string;
    displayName: string | null;
    bot: boolean;
    system: boolean;
  }>;
  webhookId: string | null;
  content: string;
  attachments: readonly Readonly<{
    id: string;
    name: string | null;
    url: string;
    contentType: string | null;
    size: number;
    width: number | null;
    height: number | null;
  }>[];
  stickers: readonly Readonly<{
    id: string;
    name: string;
    description: string | null;
    format: string;
  }>[];
  reactions: readonly Readonly<{
    emoji:
      | Readonly<{ kind: "unicode"; value: string }>
      | Readonly<{ kind: "custom"; id: string; name: string | null; animated: boolean }>;
    count: number;
    me: boolean;
  }>[];
  mentions: Readonly<{
    users: readonly Readonly<{ id: string; username: string; displayName: string | null }>[];
    roles: readonly Readonly<{ id: string; name: string | null }>[];
    channels: readonly Readonly<{ id: string; name: string | null }>[];
    everyone: boolean;
  }>;
  replyTo:
    | Readonly<{ kind: "guild"; guildId: string; channelId: string; messageId: string }>
    | Readonly<{ kind: "dm"; channelId: string; messageId: string }>
    | null;
}>;

export function normalizeDiscordMessage(source: DiscordMessageSource): DiscordMessage {
  return discordMessageSchema.parse({
    id: source.id,
    timestamp: source.timestamp.toISOString(),
    kind: source.system ? "system" : source.replyTo === null ? "default" : "reply",
    guild: source.guild,
    channel: source.channel,
    author: {
      id: source.author.id,
      kind: authorKind(source),
      username: source.author.username,
      displayName: source.author.displayName,
    },
    content: source.content,
    attachments: source.attachments,
    stickers: source.stickers,
    reactions: source.reactions,
    mentions: source.mentions,
    replyTo: source.replyTo,
  });
}

function authorKind(source: DiscordMessageSource): DiscordMessage["author"]["kind"] {
  if (source.webhookId !== null) return "webhook";
  if (source.system || source.author.system) return "system";
  return source.author.bot ? "bot" : "human";
}
