import { describe, expect, it } from "vitest";

import { DISCORD_CAPABILITY_INSTRUCTIONS } from "./discord-capability-instructions";

describe("DISCORD_CAPABILITY_INSTRUCTIONS", () => {
  it("Discord固有の実行契約だけを保持する", () => {
    expect(DISCORD_CAPABILITY_INSTRUCTIONS).toMatchInlineSnapshot(`
      "Discord participants, bots, webhooks, and system messages delivered in an accepted conversation are authorized inputs for this deployment.

      Discord MCP read tools inspect Discord state. Discord MCP write tools execute immediately during the turn and are not deduplicated against final effects.

      Discord effects are executed concurrently and are not automatically retried. Do not rely on the execution order of effects in the final array. Every file path in a Discord send or reply effect must be absolute. Do not ask the runtime to download a URL as an attachment. Do not split text that exceeds Discord's limit. Do not replace a failed reply with a channel send."
    `);
  });
});
