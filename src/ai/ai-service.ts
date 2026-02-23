import { spawn } from "node:child_process";

import type { ConversationContext, RuntimeMessage } from "../context/types";

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

export class CodexAppServerAiService implements AiService {
  constructor(private readonly command?: string) {}

  async generateReply(input: AiInput): Promise<AiOutput> {
    if (!this.command) {
      return fallbackStubReply(input);
    }

    const payload = {
      input,
      prompt: buildPrompt(input),
    };
    const responseText = await runCodexCommand(this.command, payload);
    if (!responseText) {
      return fallbackStubReply(input);
    }

    return parseAiOutput(responseText, input);
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

function parseAiOutput(rawOutput: string, fallbackInput: AiInput): AiOutput {
  try {
    const parsedJson = JSON.parse(rawOutput) as Partial<AiOutput>;
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
      shouldReply: parsedJson.shouldReply,
      replyText: parsedJson.replyText,
      needsMoreHistory: parsedJson.needsMoreHistory,
    };
    if (typeof parsedJson.requestedBeforeMessageId === "string") {
      output.requestedBeforeMessageId = parsedJson.requestedBeforeMessageId;
    }
    if (typeof parsedJson.improvementProposal === "string") {
      output.improvementProposal = parsedJson.improvementProposal;
    }

    return output;
  } catch {
    return fallbackStubReply(fallbackInput);
  }
}

async function runCodexCommand(command: string, payload: unknown): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.on("error", () => {
      resolve(null);
    });

    const timeoutId = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 30_000);

    child.on("close", (code) => {
      clearTimeout(timeoutId);
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });

    child.stdin.end(JSON.stringify(payload));
  });
}
