import { describe, expect, it, vi } from "vitest";

import type { DiscordActionPort } from "../ports/discord-action-port";

import { executeDiscordActions } from "./execute-discord-actions";

describe("executeDiscordActions", () => {
  it("全actionを並行開始し、index順に成功失敗を返す", async () => {
    const resolvers: Array<() => void> = [];
    const execute = vi.fn<DiscordActionPort["execute"]>(
      async (action) =>
        await new Promise((resolve, reject) => {
          resolvers.push(() => {
            if (action.kind === "stop_typing") {
              reject(new Error("stop failed"));
              return;
            }
            resolve({ actionKind: action.kind });
          });
        }),
    );
    const port: DiscordActionPort = { execute, releaseTyping: vi.fn() };

    const resultPromise = executeDiscordActions(
      port,
      [
        { kind: "start_typing", target: { kind: "channel", channelId: "1" } },
        { kind: "stop_typing", target: { kind: "channel", channelId: "1" } },
      ],
      "turn-1",
    );

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    for (const resolve of resolvers) resolve();

    await expect(resultPromise).resolves.toEqual([
      {
        actionKind: "start_typing",
        index: 0,
        success: true,
        target: { kind: "channel", channelId: "1" },
        value: { actionKind: "start_typing" },
      },
      {
        actionKind: "stop_typing",
        index: 1,
        success: false,
        target: { kind: "channel", channelId: "1" },
        error: "stop failed",
      },
    ]);
  });
});
