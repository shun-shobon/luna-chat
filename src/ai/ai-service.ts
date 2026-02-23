import type { ConversationContext, RuntimeMessage } from "../context/types";

import { CodexAppServerClient } from "./codex-app-server-client";
import type { DynamicToolCallParams } from "./codex-generated/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse } from "./codex-generated/v2/DynamicToolCallResponse";
import { buildPromptBundle } from "./prompt-template";

export type AiInput = {
  forceReply: boolean;
  currentMessage: RuntimeMessage;
  contextFetchLimit: number;
  tools: {
    fetchDiscordHistory: (input: {
      beforeMessageId?: string;
      limit: number;
    }) => Promise<ConversationContext>;
    sendDiscordReply: (input: { text: string }) => Promise<void>;
  };
};

export type AiOutput = {
  didReply: boolean;
};

export interface AiService {
  generateReply(input: AiInput): Promise<AiOutput>;
}

export type CodexAppServerAiServiceOptions = {
  approvalPolicy: string;
  command: string;
  cwd: string;
  debugLog?: (message: string, details?: Record<string, unknown>) => void;
  model: string;
  sandbox: string;
  timeoutMs: number;
};

export class CodexAppServerAiService implements AiService {
  constructor(private readonly options: CodexAppServerAiServiceOptions) {}

  async generateReply(input: AiInput): Promise<AiOutput> {
    let didReply = false;
    let activeThreadId: string | undefined;
    const client = new CodexAppServerClient({
      approvalPolicy: this.options.approvalPolicy,
      command: this.options.command,
      cwd: this.options.cwd,
      executeToolCall: async (params) => {
        const toolCallInput: ExecuteToolCallInput = {
          didReply: () => {
            didReply = true;
          },
          input,
          params,
        };
        if (this.options.debugLog) {
          toolCallInput.debugLog = this.options.debugLog;
        }
        if (activeThreadId) {
          toolCallInput.threadId = activeThreadId;
        }

        const result = await executeToolCall(toolCallInput);

        return result;
      },
      model: this.options.model,
      sandbox: this.options.sandbox,
      timeoutMs: this.options.timeoutMs,
    });

    try {
      await client.initialize();
      const promptBundle = buildPromptBundle(input);
      const threadId = await client.startThread({
        developerRolePrompt: promptBundle.developerRolePrompt,
        instructions: promptBundle.instructions,
      });
      activeThreadId = threadId;
      this.options.debugLog?.("ai.turn.started", {
        channelId: input.currentMessage.channelId,
        forceReply: input.forceReply,
        messageId: input.currentMessage.id,
        threadId,
      });
      const turnResult = await client.runTurn(threadId, promptBundle.userRolePrompt);
      this.options.debugLog?.("ai.turn.assistant_output", {
        assistantText: turnResult.assistantText,
        threadId,
      });
      this.options.debugLog?.("ai.turn.completed", {
        didReply,
        errorMessage: turnResult.errorMessage,
        status: turnResult.status,
        threadId,
      });
      if (turnResult.status !== "completed") {
        const errorMessage =
          turnResult.errorMessage ?? `app-server turn status is ${turnResult.status}`;
        throw new Error(errorMessage);
      }

      return {
        didReply,
      };
    } catch (error: unknown) {
      this.options.debugLog?.("ai.turn.failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        messageId: input.currentMessage.id,
        threadId: activeThreadId,
      });
      throw error;
    } finally {
      client.close();
    }
  }
}

type ExecuteToolCallInput = {
  debugLog?: (message: string, details?: Record<string, unknown>) => void;
  params: DynamicToolCallParams;
  input: AiInput;
  didReply: () => void;
  threadId?: string;
};

async function executeToolCall(input: ExecuteToolCallInput): Promise<DynamicToolCallResponse> {
  input.debugLog?.("ai.tool.call.started", {
    threadId: input.threadId,
    tool: input.params.tool,
  });
  if (input.params.tool === "fetch_discord_history") {
    const args = parseFetchDiscordHistoryArgs(
      input.params.arguments,
      input.input.contextFetchLimit,
    );
    const historyInput = {
      limit: args.limit,
    } as { beforeMessageId?: string; limit: number };
    if (args.beforeMessageId) {
      historyInput.beforeMessageId = args.beforeMessageId;
    }

    const context = await input.input.tools.fetchDiscordHistory(historyInput);
    input.debugLog?.("ai.tool.call.fetch_discord_history.completed", {
      beforeMessageId: args.beforeMessageId,
      fetchedMessages: context.recentMessages.length,
      limit: args.limit,
      threadId: input.threadId,
    });

    return toTextToolResponse({
      channelId: context.channelId,
      messages: context.recentMessages,
      requestedByToolUse: true,
    });
  }

  if (input.params.tool === "send_discord_reply") {
    const args = parseSendDiscordReplyArgs(input.params.arguments);
    input.debugLog?.("ai.tool.call.send_discord_reply", {
      text: args.text,
      threadId: input.threadId,
    });
    await input.input.tools.sendDiscordReply({
      text: args.text,
    });
    input.didReply();

    return toTextToolResponse({
      ok: true,
    });
  }

  throw new Error(`Unsupported tool: ${input.params.tool}`);
}

function parseFetchDiscordHistoryArgs(
  rawArguments: DynamicToolCallParams["arguments"],
  defaultLimit: number,
): {
  beforeMessageId?: string;
  limit: number;
} {
  if (!rawArguments || typeof rawArguments !== "object") {
    return { limit: defaultLimit };
  }

  const rawObject = rawArguments as Record<string, unknown>;
  const beforeMessageId =
    typeof rawObject["beforeMessageId"] === "string" ? rawObject["beforeMessageId"] : undefined;
  const limit =
    typeof rawObject["limit"] === "number" && rawObject["limit"] > 0
      ? Math.floor(rawObject["limit"])
      : defaultLimit;

  const result = {
    limit,
  } as { beforeMessageId?: string; limit: number };
  if (beforeMessageId) {
    result.beforeMessageId = beforeMessageId;
  }

  return result;
}

function parseSendDiscordReplyArgs(rawArguments: DynamicToolCallParams["arguments"]): {
  text: string;
} {
  if (!rawArguments || typeof rawArguments !== "object") {
    throw new Error("send_discord_reply arguments must be an object.");
  }

  const rawObject = rawArguments as Record<string, unknown>;
  const text = rawObject["text"];
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("send_discord_reply requires non-empty `text`.");
  }

  return { text };
}

function toTextToolResponse(payload: unknown): DynamicToolCallResponse {
  return {
    contentItems: [
      {
        text: JSON.stringify(payload),
        type: "inputText",
      },
    ],
    success: true,
  };
}
