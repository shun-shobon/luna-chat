import {
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type Client,
  type Interaction,
} from "discord.js";
import { z } from "zod";

import type { AgentRuntimePort } from "../../agent/ports/outbound/agent-runtime-port";
import type { ConversationCoordinator } from "../../conversation/application/conversation-coordinator";
import { conversationScopeSchema, type ConversationScope } from "../domain/conversation-scope";
import { createDiscordConversationSession } from "../domain/discord-event";
import { shouldAcceptCommand } from "../domain/message-acceptance";

type AllowedChannelSettings = Readonly<{
  ids: ReadonlySet<string>;
  change(action: "add" | "remove", channelId: string): Promise<boolean>;
}>;

const command = new SlashCommandBuilder()
  .setName("luna")
  .setDescription("会話セッションとチャンネル設定を操作します")
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addSubcommand((subcommand) =>
    subcommand.setName("end").setDescription("この場所のセッションを終了します"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("model")
      .setDescription("この場所のセッションで使うモデルと推論強度を設定します")
      .addStringOption((option) =>
        option
          .setName("model")
          .setDescription("Codex のモデル")
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName("effort")
          .setDescription("モデルが対応する推論強度")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("channel")
      .setDescription("このチャンネルの常設受付を設定します")
      .addSubcommand((subcommand) =>
        subcommand.setName("add").setDescription("このチャンネルを常設受付に追加します"),
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("remove").setDescription("このチャンネルを常設受付から削除します"),
      ),
  );

const interactionLocationSchema = z.object({
  channelId: z.string().min(1),
  guildId: z.string().nullable(),
  user: z.object({ id: z.string().min(1) }),
  channel: z
    .object({
      type: z.enum(ChannelType),
      parentId: z.string().nullable().optional(),
      members: z.unknown().optional(),
    })
    .nullable(),
});
const threadMemberSchema = z.object({ me: z.object({ id: z.string() }).nullable() });
const selectedOptionSchema = z.string().min(1);
const sdkInteractionSchema = z.custom<Interaction>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "isAutocomplete") === "function" &&
    typeof Reflect.get(value, "isChatInputCommand") === "function",
);

export interface DiscordCommandClient {
  on(event: "interactionCreate", listener: (interaction: unknown) => void): void;
  off(event: "interactionCreate", listener: (interaction: unknown) => void): void;
  register(): Promise<void>;
}

export function createDiscordCommandClient(client: Client): DiscordCommandClient {
  return {
    on: (_event, listener) => client.on("interactionCreate", listener),
    off: (_event, listener) => client.off("interactionCreate", listener),
    register: async () => {
      const application = client.application;
      if (application === null) throw new Error("Discord application is unavailable after login");
      await application.commands.create(command);
    },
  };
}

export class DiscordCommandAdapter {
  readonly #listener: (interaction: unknown) => void;
  #started = false;

  constructor(
    private readonly client: DiscordCommandClient,
    private readonly conversation: Pick<
      ConversationCoordinator,
      "hasSession" | "configure" | "endSession"
    >,
    private readonly agent: Pick<AgentRuntimePort, "listModels">,
    private readonly allowDm: boolean,
    private readonly allowedChannels: AllowedChannelSettings,
    private readonly onError: (error: unknown) => void,
  ) {
    this.#listener = (interaction) => {
      void this.#handle(interaction).catch(this.onError);
    };
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("Discord command adapter is already started");
    await this.client.register();
    this.client.on("interactionCreate", this.#listener);
    this.#started = true;
  }

  stop(): void {
    if (!this.#started) throw new Error("Discord command adapter is not started");
    this.client.off("interactionCreate", this.#listener);
    this.#started = false;
  }

  async #handle(rawInteraction: unknown): Promise<void> {
    const interaction = sdkInteractionSchema.parse(rawInteraction);
    if (!interaction.isAutocomplete() && !interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "luna") return;
    try {
      const { scope, lunaIsThreadMember } = resolveLocation(interaction);
      const session = createDiscordConversationSession(scope);
      const channelCommand = interaction.options.getSubcommandGroup(false) === "channel";
      const allowed = shouldAcceptCommand({
        scope,
        allowDm: this.allowDm,
        allowedChannelIds: this.allowedChannels.ids,
        lunaIsThreadMember,
        sessionExists: this.conversation.hasSession(session.key),
      });
      if (interaction.isAutocomplete()) {
        if (!allowed || channelCommand || interaction.options.getSubcommand() !== "model") {
          await interaction.respond([]);
          return;
        }
        const focused = interaction.options.getFocused(true);
        const models = await this.agent.listModels();
        if (focused.name === "model") {
          const query = focused.value.toLowerCase();
          await interaction.respond(
            models
              .filter(
                (item) =>
                  item.model.toLowerCase().includes(query) ||
                  item.displayName.toLowerCase().includes(query),
              )
              .slice(0, 25)
              .map((item) => ({ name: item.displayName.slice(0, 100), value: item.model })),
          );
          return;
        }
        const selectedModel = interaction.options.getString("model");
        const model = models.find((item) => item.model === selectedModel);
        await interaction.respond(
          (model?.supportedReasoningEfforts ?? [])
            .filter((effort) => effort.toLowerCase().includes(focused.value.toLowerCase()))
            .slice(0, 25)
            .map((effort) => ({ name: effort, value: effort })),
        );
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (channelCommand) {
        if (scope.kind === "dm") {
          await interaction.editReply("チャンネル設定は Guild 内で実行してください。");
          return;
        }
        const channelId = scope.kind === "guild_thread" ? scope.threadId : scope.channelId;
        const action = interaction.options.getSubcommand();
        if (action !== "add" && action !== "remove") throw new Error("Unknown channel command");
        const changed = await this.allowedChannels.change(action, channelId);
        const verb = action === "add" ? "追加" : "削除";
        const parentStillAllowed =
          action === "remove" &&
          scope.kind === "guild_thread" &&
          this.allowedChannels.ids.has(scope.parentChannelId);
        await interaction.editReply(
          changed
            ? `このチャンネルを allowed_channel_ids ${action === "add" ? "に" : "から"}${verb}しました。${parentStillAllowed ? "親チャンネルが登録されているため、このスレッドの常設受付は続きます。" : ""}`
            : `このチャンネルは既に${action === "add" ? "登録済み" : "未登録"}です。`,
        );
        return;
      }
      if (!allowed) {
        await interaction.editReply("この場所では Luna の会話コマンドを使えません。");
        return;
      }
      if (interaction.options.getSubcommand() === "end") {
        const ended = this.conversation.endSession(session.key);
        await interaction.editReply(
          ended
            ? "セッションの終了を受け付けました。処理中の turn と Effect が終わった後、セッションをアーカイブします。"
            : "この場所に終了するセッションはありません。",
        );
        return;
      }
      const modelName = selectedOptionSchema.parse(interaction.options.getString("model"));
      const effort = selectedOptionSchema.parse(interaction.options.getString("effort"));
      const models = await this.agent.listModels();
      const model = models.find((item) => item.model === modelName);
      if (model === undefined || !model.supportedReasoningEfforts.includes(effort)) {
        await interaction.editReply("モデルと推論強度の組み合わせが利用できません。");
        return;
      }
      if (!this.conversation.configure(session, { model: modelName, effort })) {
        await interaction.editReply("セッションの終了処理中です。完了後に再実行してください。");
        return;
      }
      await interaction.editReply(
        `このセッションのモデルを ${model.displayName}、推論強度を ${effort} に設定しました。`,
      );
    } catch (error: unknown) {
      this.onError(error);
      if (interaction.isAutocomplete()) {
        if (!interaction.responded) await interaction.respond([]);
      } else if (interaction.deferred || interaction.replied) {
        await interaction.editReply("コマンドの処理に失敗しました。");
      } else {
        await interaction.reply({
          content: "コマンドの処理に失敗しました。",
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  }
}

function resolveLocation(interaction: Interaction): {
  scope: ConversationScope;
  lunaIsThreadMember: boolean;
} {
  const location = interactionLocationSchema.parse(interaction);
  if (location.guildId === null) {
    return {
      scope: conversationScopeSchema.parse({
        kind: "dm",
        channelId: location.channelId,
        userId: location.user.id,
      }),
      lunaIsThreadMember: false,
    };
  }
  const channel = location.channel;
  if (channel === null) throw new Error("Discord interaction channel is unavailable");
  if (
    channel.type === ChannelType.AnnouncementThread ||
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread
  ) {
    const member = threadMemberSchema.safeParse(channel.members);
    return {
      scope: conversationScopeSchema.parse({
        kind: "guild_thread",
        guildId: location.guildId,
        parentChannelId: channel.parentId,
        threadId: location.channelId,
      }),
      lunaIsThreadMember: member.success && member.data.me !== null,
    };
  }
  return {
    scope: conversationScopeSchema.parse({
      kind: "guild_channel",
      guildId: location.guildId,
      channelId: location.channelId,
    }),
    lunaIsThreadMember: false,
  };
}
