import type { DiscordAction } from "../domain/discord-action";
import type {
  DiscordActionBatchPort,
  DiscordActionResult,
} from "../ports/discord-action-batch-port";
import type { DiscordActionPort } from "../ports/discord-action-port";

export async function executeDiscordActions(
  port: DiscordActionPort,
  actions: readonly DiscordAction[],
  ownerId: string,
): Promise<readonly DiscordActionResult[]> {
  const settled = await Promise.allSettled(
    actions.map(async (action) => await port.execute(action, ownerId)),
  );

  return settled.map((result, index) => {
    const action = actions[index];
    if (action === undefined) throw new Error("Discord action result lost its input reference");
    return result.status === "fulfilled"
      ? {
          actionKind: action.kind,
          index,
          success: true,
          target: actionTarget(action),
          value: result.value,
        }
      : {
          actionKind: action.kind,
          index,
          success: false,
          target: actionTarget(action),
          error: toErrorMessage(result.reason),
        };
  });
}

export function createDiscordActionBatchPort(port: DiscordActionPort): DiscordActionBatchPort {
  return {
    execute: async (actions, ownerId) => await executeDiscordActions(port, actions, ownerId),
    releaseTyping: async (ownerId) => await port.releaseTyping(ownerId),
  };
}

function toErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function actionTarget(action: DiscordAction) {
  switch (action.kind) {
    case "send_message":
    case "start_typing":
    case "stop_typing":
      return action.target;
    case "reply_message":
    case "add_reaction":
    case "remove_reaction":
      return { kind: "message" as const, channelId: action.channelId, messageId: action.messageId };
  }
}
