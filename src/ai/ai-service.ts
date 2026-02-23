import type { ConversationContext, RuntimeMessage } from "../context/types";

import { CodexAppServerClient } from "./codex-app-server-client";
import { buildPrompt } from "./prompt-template";

const REPLY_TRIGGER_PATTERN = /[?？]|ルナ|るな|luna|こんにちは|こんばんは|おはよう/u;

export type AiInput = {
  forceReply: boolean;
  currentMessage: RuntimeMessage;
  context: ConversationContext;
  operationRulesDoc: string;
};

export type AiOutput = {
  shouldReply: boolean;
  replyText: string;
  needsMoreHistory: boolean;
  requestedBeforeMessageId?: string;
  improvementProposal?: string;
};

export interface AiService {
  generateReply(input: AiInput): Promise<AiOutput>;
}

export type CodexAppServerAiServiceOptions = {
  approvalPolicy: string;
  command?: string;
  cwd: string;
  model: string;
  sandbox: string;
  timeoutMs: number;
};

export class CodexAppServerAiService implements AiService {
  constructor(private readonly options: CodexAppServerAiServiceOptions) {}

  async generateReply(input: AiInput): Promise<AiOutput> {
    if (!this.options.command) {
      return fallbackStubReply(input);
    }

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
      const threadId = await client.startThread();
      const prompt = buildPrompt(input);
      const turnResult = await client.runTurn(threadId, prompt);
      if (turnResult.status !== "completed") {
        const errorMessage =
          turnResult.errorMessage ?? `app-server turn status is ${turnResult.status}`;
        throw new Error(errorMessage);
      }

      return parseAssistantOutput(turnResult.assistantText, input);
    } finally {
      client.close();
    }
  }
}

function fallbackStubReply(input: AiInput): AiOutput {
  if (input.forceReply) {
    return {
      shouldReply: true,
      replyText: "呼んだ？ ここにいるよ。",
      needsMoreHistory: false,
    };
  }

  const shouldReply = REPLY_TRIGGER_PATTERN.test(input.currentMessage.content);
  if (!shouldReply) {
    return {
      shouldReply: false,
      replyText: "",
      needsMoreHistory: false,
    };
  }

  return {
    shouldReply: true,
    replyText: "うん、どうしたの？",
    needsMoreHistory: false,
  };
}

function parseAssistantOutput(rawOutput: string, fallbackInput: AiInput): AiOutput {
  const jsonText = extractJsonObject(rawOutput);
  if (!jsonText) {
    return fallbackStubReply(fallbackInput);
  }

  let parsedJson: Partial<AiOutput>;
  try {
    parsedJson = JSON.parse(jsonText) as Partial<AiOutput>;
  } catch {
    return fallbackStubReply(fallbackInput);
  }

  if (typeof parsedJson.shouldReply !== "boolean") {
    return fallbackStubReply(fallbackInput);
  }
  if (typeof parsedJson.replyText !== "string") {
    return fallbackStubReply(fallbackInput);
  }
  if (typeof parsedJson.needsMoreHistory !== "boolean") {
    return fallbackStubReply(fallbackInput);
  }

  const output: AiOutput = {
    needsMoreHistory: parsedJson.needsMoreHistory,
    replyText: parsedJson.replyText,
    shouldReply: parsedJson.shouldReply,
  };
  if (typeof parsedJson.requestedBeforeMessageId === "string") {
    output.requestedBeforeMessageId = parsedJson.requestedBeforeMessageId;
  }
  if (typeof parsedJson.improvementProposal === "string") {
    output.improvementProposal = parsedJson.improvementProposal;
  }

  return output;
}

function extractJsonObject(text: string): string | undefined {
  const firstBrace = text.indexOf("{");
  if (firstBrace < 0) {
    return undefined;
  }

  let depth = 0;
  for (let index = firstBrace; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(firstBrace, index + 1);
      }
    }
  }

  return undefined;
}
