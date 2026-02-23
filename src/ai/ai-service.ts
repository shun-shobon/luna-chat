import { resolve } from "node:path";

import type { RuntimeMessage } from "../context/types";

import { CodexAppServerClient } from "./codex-app-server-client";
import { buildPromptBundle } from "./prompt-template";

export type AiInput = {
  forceReply: boolean;
  currentMessage: RuntimeMessage;
  contextFetchLimit: number;
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
    let activeThreadId: string | undefined;
    const client = new CodexAppServerClient({
      approvalPolicy: this.options.approvalPolicy,
      command: this.options.command,
      cwd: this.options.cwd,
      model: this.options.model,
      sandbox: this.options.sandbox,
      timeoutMs: this.options.timeoutMs,
    });

    try {
      await client.initialize();
      const promptBundle = buildPromptBundle(input);
      const threadId = await client.startThread({
        config: buildMcpConfig(),
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
      for (const toolCall of turnResult.mcpToolCalls) {
        this.options.debugLog?.("ai.turn.mcp_tool_call", {
          arguments: toolCall.arguments,
          server: toolCall.server,
          status: toolCall.status,
          threadId,
          tool: toolCall.tool,
        });
      }
      const didReply = turnResult.mcpToolCalls.some((toolCall) => {
        return toolCall.status === "completed" && toolCall.tool === "send_discord_reply";
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

function buildMcpConfig(): Record<string, unknown> {
  const mcpServerScriptPath = resolve(process.cwd(), "src/mcp/discord-mcp-server.ts");
  return {
    mcp_servers: {
      discord: {
        args: ["exec", "tsx", mcpServerScriptPath],
        command: "pnpm",
      },
    },
  };
}
