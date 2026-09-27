import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { AgentRuntimePort } from "../../agent/ports/outbound/agent-runtime-port";
import type { ConversationCoordinator } from "../../conversation/application/conversation-coordinator";

import { DiscordCommandAdapter, type DiscordCommandClient } from "./discord-command-adapter";

const models = [
  {
    model: "gpt-6-sol",
    displayName: "GPT-6 Sol",
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    model: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    supportedReasoningEfforts: ["high", "xhigh"],
  },
];

class FakeClient implements DiscordCommandClient {
  readonly register = vi.fn(async () => undefined);
  listener: ((interaction: unknown) => void) | undefined;

  on(_event: "interactionCreate", listener: (interaction: unknown) => void): void {
    this.listener = listener;
  }

  off(_event: "interactionCreate", listener: (interaction: unknown) => void): void {
    if (this.listener === listener) this.listener = undefined;
  }

  emit(interaction: unknown): void {
    this.listener?.(interaction);
  }
}

function createHarness(input: { allowedChannelIds?: string[]; sessionExists?: boolean } = {}) {
  const client = new FakeClient();
  const conversation = {
    hasSession: vi.fn<ConversationCoordinator["hasSession"]>(() => input.sessionExists ?? false),
    configure: vi.fn<ConversationCoordinator["configure"]>(() => true),
    endSession: vi.fn<ConversationCoordinator["endSession"]>(() => true),
  };
  const agent = { listModels: vi.fn<AgentRuntimePort["listModels"]>(async () => models) };
  const onError = vi.fn();
  const adapter = new DiscordCommandAdapter(
    client,
    conversation,
    agent,
    true,
    input.allowedChannelIds ?? ["300"],
    onError,
  );
  return { client, conversation, agent, onError, adapter };
}

function commandInteraction(
  subcommand: "model" | "end",
  input: { model?: string; effort?: string; channelId?: string } = {},
) {
  const editReply = vi.fn(async (_content: string) => undefined);
  const reply = vi.fn(async () => undefined);
  const interaction = {
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    commandName: "luna",
    channelId: input.channelId ?? "300",
    guildId: "200",
    user: { id: "400" },
    channel: { type: ChannelType.GuildText, parentId: null },
    options: {
      getSubcommand: () => subcommand,
      getString: (name: string) => (name === "model" ? input.model : input.effort),
    },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply,
    reply,
    deferred: false,
    replied: false,
  };
  return interaction;
}

describe("DiscordCommandAdapter", () => {
  it("コマンド登録失敗時はinteractionを購読しない", async () => {
    const harness = createHarness();
    harness.client.register.mockRejectedValueOnce(new Error("registration failed"));
    await expect(harness.adapter.start()).rejects.toThrow("registration failed");
    expect(harness.client.listener).toBeUndefined();
  });

  it("登録後にモデルと強度を同時に設定し、停止時に購読を外す", async () => {
    const harness = createHarness();
    await harness.adapter.start();
    expect(harness.client.register).toHaveBeenCalledOnce();
    const interaction = commandInteraction("model", { model: "gpt-6-astra", effort: "xhigh" });
    harness.client.emit(interaction);
    await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalledOnce());
    expect(harness.conversation.configure).toHaveBeenCalledWith(
      {
        key: "discord:guild_channel:200:300",
        source: "discord/main",
        context: { kind: "guild_channel", guildId: "200", channelId: "300" },
      },
      { model: "gpt-6-astra", effort: "xhigh" },
    );
    harness.adapter.stop();
    expect(harness.client.listener).toBeUndefined();
  });

  it("非対応の組み合わせと対象外channelを拒否する", async () => {
    const harness = createHarness();
    await harness.adapter.start();
    const invalid = commandInteraction("model", { model: "gpt-6-astra", effort: "low" });
    harness.client.emit(invalid);
    await vi.waitFor(() => expect(invalid.editReply).toHaveBeenCalledOnce());
    expect(invalid.editReply).toHaveBeenCalledWith(
      "モデルと推論強度の組み合わせが利用できません。",
    );
    expect(harness.conversation.configure).not.toHaveBeenCalled();

    const outside = commandInteraction("model", {
      model: "gpt-6-sol",
      effort: "medium",
      channelId: "999",
    });
    harness.client.emit(outside);
    await vi.waitFor(() => expect(outside.editReply).toHaveBeenCalledOnce());
    expect(harness.agent.listModels).toHaveBeenCalledOnce();
    expect(harness.conversation.configure).not.toHaveBeenCalled();
  });

  it("モデル候補と選択モデルの強度候補を返す", async () => {
    const harness = createHarness();
    await harness.adapter.start();
    const modelInteraction = {
      ...commandInteraction("model", { model: "gpt-6-astra", effort: "xhigh" }),
      isAutocomplete: () => true,
      isChatInputCommand: () => false,
      options: {
        getSubcommand: () => "model",
        getFocused: () => ({ name: "model", value: "astra" }),
        getString: () => "gpt-6-astra",
      },
      respond: vi.fn(async () => undefined),
      responded: false,
    };
    harness.client.emit(modelInteraction);
    await vi.waitFor(() => expect(modelInteraction.respond).toHaveBeenCalledOnce());
    expect(modelInteraction.respond).toHaveBeenCalledWith([
      { name: "GPT-6 Astra", value: "gpt-6-astra" },
    ]);

    const effortInteraction = {
      ...modelInteraction,
      options: {
        getSubcommand: () => "model",
        getFocused: () => ({ name: "effort", value: "x" }),
        getString: () => "gpt-6-astra",
      },
      respond: vi.fn(async () => undefined),
    };
    harness.client.emit(effortInteraction);
    await vi.waitFor(() => expect(effortInteraction.respond).toHaveBeenCalledOnce());
    expect(effortInteraction.respond).toHaveBeenCalledWith([{ name: "xhigh", value: "xhigh" }]);
  });

  it("終了コマンドは対象sessionだけに送る", async () => {
    const harness = createHarness();
    await harness.adapter.start();
    const interaction = commandInteraction("end");
    harness.client.emit(interaction);
    await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalledOnce());
    expect(harness.conversation.endSession).toHaveBeenCalledWith("discord:guild_channel:200:300");
    expect(harness.agent.listModels).not.toHaveBeenCalled();
  });

  it("モデル取得例外を利用者に返し、sessionを変更しない", async () => {
    const harness = createHarness();
    harness.agent.listModels.mockRejectedValueOnce(new Error("offline"));
    await harness.adapter.start();
    const interaction = commandInteraction("model", { model: "gpt-6-sol", effort: "medium" });
    harness.client.emit(interaction);
    await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalledOnce());
    expect(interaction.editReply).toHaveBeenCalledWith("コマンドの処理に失敗しました。");
    expect(harness.onError).toHaveBeenCalledOnce();
    expect(harness.conversation.configure).not.toHaveBeenCalled();
  });
});
