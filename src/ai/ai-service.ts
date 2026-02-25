import type { RuntimeMessage } from "../context/types";
import { logger } from "../logger";

import { CodexAppServerClient } from "./codex-app-server-client";
import type { ReasoningEffort } from "./codex-generated/ReasoningEffort";
import { buildPromptBundle } from "./prompt-template";

export type AiInput = {
  channelName: string;
  currentMessage: RuntimeMessage;
  recentMessages: RuntimeMessage[];
};

export interface AiService {
  generateReply(input: AiInput): Promise<void>;
}

export type CodexAppServerAiServiceOptions = {
  approvalPolicy: string;
  command: string;
  codexHomeDir: string;
  cwd: string;
  discordMcpServerUrl: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  sandbox: string;
  timeoutMs: number;
};

export class CodexAppServerAiService implements AiService {
  constructor(private readonly options: CodexAppServerAiServiceOptions) {}

  async generateReply(input: AiInput): Promise<void> {
    let activeThreadId: string | undefined;
    const client = new CodexAppServerClient({
      approvalPolicy: this.options.approvalPolicy,
      command: this.options.command,
      codexHomeDir: this.options.codexHomeDir,
      cwd: this.options.cwd,
      model: this.options.model,
      sandbox: this.options.sandbox,
      timeoutMs: this.options.timeoutMs,
    });

    try {
      await client.initialize();
      const promptBundle = await buildPromptBundle(input, this.options.cwd);
      const threadId = await client.startThread({
        config: buildThreadConfig(this.options.reasoningEffort, this.options.discordMcpServerUrl),
        developerRolePrompt: promptBundle.developerRolePrompt,
        instructions: promptBundle.instructions,
      });
      activeThreadId = threadId;
      logger.debug("ai.turn.started", {
        channelId: input.currentMessage.channelId,
        messageId: input.currentMessage.id,
        threadId,
      });
      const turnResult = await client.runTurn(threadId, promptBundle.userRolePrompt);
      logger.debug("ai.turn.assistant_output", {
        assistantText: turnResult.assistantText,
        threadId,
      });
      for (const toolCall of turnResult.mcpToolCalls) {
        logger.debug("ai.turn.mcp_tool_call", {
          arguments: toolCall.arguments,
          server: toolCall.server,
          status: toolCall.status,
          threadId,
          tool: toolCall.tool,
        });
      }
      logger.debug("ai.turn.completed", {
        errorMessage: turnResult.errorMessage,
        status: turnResult.status,
        threadId,
      });
      if (turnResult.status !== "completed") {
        const errorMessage =
          turnResult.errorMessage ?? `app-server turn status is ${turnResult.status}`;
        throw new Error(errorMessage);
      }
    } catch (error: unknown) {
      logger.debug("ai.turn.failed", {
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

export function buildThreadConfig(
  reasoningEffort: ReasoningEffort,
  discordMcpServerUrl: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    model_reasoning_effort: reasoningEffort,
    mcp_servers: {
      discord: {
        url: discordMcpServerUrl,
      },
    },
  };

  return config;
}
