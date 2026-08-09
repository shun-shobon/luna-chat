import { describe, expect, it, vi } from "vitest";

import { createEffectOutputContract } from "../../effect/application/effect-output-contract";
import { createEffectRegistry } from "../../effect/application/effect-registry";
import { createEffectBatchExecutor } from "../../effect/application/execute-effect-batch";
import type { EffectDefinition } from "../../effect/ports/effect-provider";
import type { JsonValue } from "../../event/domain/luna-event";
import type { DiscordActionPort } from "../ports/discord-action-port";

import { createDiscordEffectProvider } from "./discord-effect-provider";

describe("Discord Effect Provider", () => {
  it("六つのnamespaced Effectを対応するDiscord Actionへ写像する", async () => {
    const actions = createActionPort();
    const provider = createDiscordEffectProvider(actions);
    const cases: readonly Readonly<{
      type: string;
      input: JsonValue;
      action: JsonValue;
      target: JsonValue;
    }>[] = [
      {
        type: "discord.send_message",
        input: {
          target: { kind: "dm_user", userId: "100" },
          content: "hello",
          files: null,
        },
        action: {
          kind: "send_message",
          target: { kind: "dm_user", userId: "100" },
          content: "hello",
        },
        target: { kind: "dm_user", userId: "100" },
      },
      {
        type: "discord.reply_message",
        input: {
          channelId: "200",
          messageId: "300",
          content: null,
          files: [{ path: "/tmp/result.txt", fileName: null, description: "result" }],
        },
        action: {
          kind: "reply_message",
          channelId: "200",
          messageId: "300",
          files: [{ path: "/tmp/result.txt", description: "result" }],
        },
        target: { kind: "message", channelId: "200", messageId: "300" },
      },
      {
        type: "discord.add_reaction",
        input: {
          channelId: "200",
          messageId: "300",
          emoji: { kind: "unicode", value: "🌙" },
        },
        action: {
          kind: "add_reaction",
          channelId: "200",
          messageId: "300",
          emoji: { kind: "unicode", value: "🌙" },
        },
        target: { kind: "message", channelId: "200", messageId: "300" },
      },
      {
        type: "discord.remove_reaction",
        input: {
          channelId: "200",
          messageId: "300",
          emoji: { kind: "custom", id: "400", name: null },
        },
        action: {
          kind: "remove_reaction",
          channelId: "200",
          messageId: "300",
          emoji: { kind: "custom", id: "400" },
        },
        target: { kind: "message", channelId: "200", messageId: "300" },
      },
      {
        type: "discord.start_typing",
        input: { target: { kind: "channel", channelId: "200" } },
        action: { kind: "start_typing", target: { kind: "channel", channelId: "200" } },
        target: { kind: "channel", channelId: "200" },
      },
      {
        type: "discord.stop_typing",
        input: { target: { kind: "channel", channelId: "200" } },
        action: { kind: "stop_typing", target: { kind: "channel", channelId: "200" } },
        target: { kind: "channel", channelId: "200" },
      },
    ];

    expect(provider.definitions.map((definition) => definition.type)).toEqual(
      cases.map(({ type }) => type),
    );
    for (const testCase of cases) {
      const definition = findDefinition(provider.definitions, testCase.type);
      const parsed = definition.parseInput(testCase.input);
      expect(definition.describeTarget(parsed)).toEqual(testCase.target);
      await expect(definition.execute(parsed, "owner-1")).resolves.toMatchObject({
        actionKind: expect.any(String),
      });
    }

    expect(actions.execute.mock.calls.map(([action, ownerId]) => ({ action, ownerId }))).toEqual(
      cases.map(({ action }) => ({ action, ownerId: "owner-1" })),
    );
  });

  it("Agent向け入力をstrictに検証する", () => {
    const provider = createDiscordEffectProvider(createActionPort());
    const send = findDefinition(provider.definitions, "discord.send_message");
    const reaction = findDefinition(provider.definitions, "discord.add_reaction");

    expect(() =>
      send.parseInput({
        target: { kind: "channel", channelId: "200" },
        content: null,
        files: null,
      }),
    ).toThrow("A message requires content or files");
    expect(() =>
      send.parseInput({
        target: { kind: "channel", channelId: "200" },
        content: null,
        files: [{ path: "relative.txt", fileName: null, description: null }],
      }),
    ).toThrow("File path must be absolute");
    expect(() =>
      reaction.parseInput({
        channelId: "200",
        messageId: "300",
        emoji: { kind: "custom", id: "400", name: null },
        extra: true,
      }),
    ).toThrow();
  });

  it("execution ownerのtyping resourceを既存portへ解放する", async () => {
    const actions = createActionPort();
    const provider = createDiscordEffectProvider(actions);

    await provider.release("owner-1");

    expect(actions.releaseTyping).toHaveBeenCalledWith("owner-1");
  });

  it("Codex Structured Outputsで使用可能なSchemaを提供する", () => {
    const provider = createDiscordEffectProvider(createActionPort());

    expect(() => createEffectOutputContract(createEffectRegistry([provider]))).not.toThrow();
  });

  it("Agent outputを正規化してBatchからDiscord Actionまで実行する", async () => {
    const actions = createActionPort();
    const registry = createEffectRegistry([createDiscordEffectProvider(actions)]);
    const contract = createEffectOutputContract(registry);
    const batch = createEffectBatchExecutor(registry, { log: vi.fn() });
    const output = contract.parse(
      JSON.stringify({
        effects: [
          {
            type: "discord.send_message",
            input: {
              target: { kind: "channel", channelId: "200" },
              content: "hello",
              files: null,
            },
          },
        ],
      }),
    );

    await expect(batch.execute(output.effects, "owner-1")).resolves.toEqual([
      {
        index: 0,
        type: "discord.send_message",
        target: { kind: "channel", channelId: "200" },
        success: true,
        value: { actionKind: "send_message" },
      },
    ]);
    expect(actions.execute).toHaveBeenCalledWith(
      {
        kind: "send_message",
        target: { kind: "channel", channelId: "200" },
        content: "hello",
      },
      "owner-1",
    );
  });
});

function findDefinition(definitions: readonly EffectDefinition[], type: string): EffectDefinition {
  const definition = definitions.find((candidate) => candidate.type === type);
  if (definition === undefined) throw new Error(`Missing Effect definition ${type}`);
  return definition;
}

function createActionPort() {
  return {
    execute: vi.fn<DiscordActionPort["execute"]>(async (action) => ({ actionKind: action.kind })),
    releaseTyping: vi.fn<DiscordActionPort["releaseTyping"]>(async () => undefined),
  };
}
