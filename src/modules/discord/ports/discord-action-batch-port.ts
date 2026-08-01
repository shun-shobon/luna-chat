import type { DiscordAction, DiscordTarget } from "../domain/discord-action";

import type { DiscordActionSuccess } from "./discord-action-port";

type DiscordActionResultTarget =
  | DiscordTarget
  | Readonly<{ kind: "message"; channelId: string; messageId: string }>;

type DiscordActionResultReference = Readonly<{
  actionKind: DiscordAction["kind"];
  index: number;
  target: DiscordActionResultTarget;
}>;

export type DiscordActionResult = DiscordActionResultReference &
  (
    | Readonly<{ success: true; value: DiscordActionSuccess }>
    | Readonly<{ success: false; error: string }>
  );

export interface DiscordActionBatchPort {
  execute(
    actions: readonly DiscordAction[],
    ownerId: string,
  ): Promise<readonly DiscordActionResult[]>;
  releaseTyping(ownerId: string): Promise<void>;
}
