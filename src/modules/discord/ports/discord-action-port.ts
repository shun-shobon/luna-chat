import type { DiscordAction } from "../domain/discord-action";

export type DiscordActionSuccess = Readonly<{
  actionKind: DiscordAction["kind"];
  detail?: Readonly<Record<string, string>>;
}>;

export interface DiscordActionPort {
  execute(action: DiscordAction, ownerId: string): Promise<DiscordActionSuccess>;
  releaseTyping(ownerId: string): Promise<void>;
}
