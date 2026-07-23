import { z } from "zod";

import { agentOutputSchema, type AgentOutput } from "../../discord/domain/discord-action";
import { discordIdSchema } from "../../discord/domain/discord-id";

const agentDiscordTargetSchema = z.union([
  z.strictObject({ kind: z.literal("channel"), channelId: discordIdSchema }),
  z.strictObject({ kind: z.literal("dm_user"), userId: discordIdSchema }),
]);

const agentSendFileSchema = z.strictObject({
  path: z.string(),
  fileName: z.string().nullable(),
  description: z.string().nullable(),
});

const agentDiscordEmojiSchema = z.union([
  z.strictObject({ kind: z.literal("unicode"), value: z.string() }),
  z.strictObject({
    kind: z.literal("custom"),
    id: discordIdSchema,
    name: z.string().nullable(),
  }),
]);

const nullableMessageFields = {
  content: z.string().nullable(),
  files: z.array(agentSendFileSchema).min(1).nullable(),
};

const messageLocationShape = {
  channelId: discordIdSchema,
  messageId: discordIdSchema,
};

const agentDiscordActionSchema = z.union([
  z.strictObject({
    kind: z.literal("send_message"),
    target: agentDiscordTargetSchema,
    ...nullableMessageFields,
  }),
  z.strictObject({
    kind: z.literal("reply_message"),
    ...messageLocationShape,
    ...nullableMessageFields,
  }),
  z.strictObject({
    kind: z.literal("add_reaction"),
    ...messageLocationShape,
    emoji: agentDiscordEmojiSchema,
  }),
  z.strictObject({
    kind: z.literal("remove_reaction"),
    ...messageLocationShape,
    emoji: agentDiscordEmojiSchema,
  }),
  z.strictObject({ kind: z.literal("start_typing"), target: agentDiscordTargetSchema }),
  z.strictObject({ kind: z.literal("stop_typing"), target: agentDiscordTargetSchema }),
]);

const agentStructuredOutputSchema = z.strictObject({
  actions: z.array(agentDiscordActionSchema),
});

export const AGENT_OUTPUT_JSON_SCHEMA = z.toJSONSchema(agentStructuredOutputSchema);

class AgentOutputParseError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentOutputParseError";
  }
}

function normalizeNullableFields<
  T extends { content: string | null; files: AgentSendFile[] | null },
>(value: T): Record<string, unknown> {
  return {
    ...(value.content === null ? {} : { content: value.content }),
    ...(value.files === null ? {} : { files: value.files.map(normalizeSendFile) }),
  };
}

function normalizeSendFile(file: AgentSendFile): Record<string, unknown> {
  return {
    path: file.path,
    ...(file.fileName === null ? {} : { fileName: file.fileName }),
    ...(file.description === null ? {} : { description: file.description }),
  };
}

function normalizeEmoji(emoji: AgentDiscordEmoji): Record<string, unknown> {
  if (emoji.kind === "unicode") {
    return emoji;
  }
  return {
    kind: emoji.kind,
    id: emoji.id,
    ...(emoji.name === null ? {} : { name: emoji.name }),
  };
}

function normalizeAction(action: AgentDiscordAction): Record<string, unknown> {
  switch (action.kind) {
    case "send_message":
      return {
        kind: action.kind,
        target: action.target,
        ...normalizeNullableFields(action),
      };
    case "reply_message":
      return {
        kind: action.kind,
        channelId: action.channelId,
        messageId: action.messageId,
        ...normalizeNullableFields(action),
      };
    case "add_reaction":
    case "remove_reaction":
      return {
        kind: action.kind,
        channelId: action.channelId,
        messageId: action.messageId,
        emoji: normalizeEmoji(action.emoji),
      };
    case "start_typing":
    case "stop_typing":
      return action;
  }
}

function parseAgentOutput(value: unknown): AgentOutput {
  const structuredResult = agentStructuredOutputSchema.safeParse(value);
  if (!structuredResult.success) {
    throw new AgentOutputParseError(z.prettifyError(structuredResult.error));
  }

  const result = agentOutputSchema.safeParse({
    actions: structuredResult.data.actions.map(normalizeAction),
  });
  if (!result.success) {
    throw new AgentOutputParseError(z.prettifyError(result.error));
  }
  return result.data;
}

export function parseAgentOutputText(text: string): AgentOutput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    throw new AgentOutputParseError("Agent output is not valid JSON.", { cause: error });
  }
  return parseAgentOutput(value);
}

type AgentSendFile = z.infer<typeof agentSendFileSchema>;
type AgentDiscordEmoji = z.infer<typeof agentDiscordEmojiSchema>;
type AgentDiscordAction = z.infer<typeof agentDiscordActionSchema>;
