import type { AskForApproval } from "../../../codex-generated/v2/AskForApproval";
import type { SandboxMode } from "../../../codex-generated/v2/SandboxMode";
import type { ThreadStartParams } from "../../../codex-generated/v2/ThreadStartParams";
import type { TurnStartParams } from "../../../codex-generated/v2/TurnStartParams";
import type { TurnSteerParams } from "../../../codex-generated/v2/TurnSteerParams";
import type { UserInput } from "../../../codex-generated/v2/UserInput";
import type { StartedTurn } from "../../../ports/outbound/ai-runtime-port";

import {
  createJsonRpcClient,
  extractThreadId,
  extractTurnId,
  isApprovalPolicy,
  isSandboxMode,
  normalizeThreadStartConfig,
  CLIENT_INFO,
} from "./json-rpc-client";
import { startStdioProcess, type StdioProcessOptions } from "./stdio-process";
import {
  createTurnTracker,
  handleTurnNotification,
  waitForTurnCompletion,
} from "./turn-result-collector";

type CodexAiRuntimeOptions = StdioProcessOptions & {
  approvalPolicy: string;
  model: string;
  sandbox: string;
  timeoutMs: number;
};

export class CodexAiRuntime {
  private readonly processHandle;
  private readonly rpcClient;

  constructor(private readonly options: CodexAiRuntimeOptions) {
    this.processHandle = startStdioProcess(options);
    this.rpcClient = createJsonRpcClient(this.processHandle);
  }

  async initialize(): Promise<void> {
    await this.rpcClient.request("initialize", {
      capabilities: null,
      clientInfo: CLIENT_INFO,
    });
    this.rpcClient.notifyInitialized();
  }

  async startThread(input: {
    instructions: string;
    developerRolePrompt: string;
    config?: Record<string, unknown>;
  }): Promise<string> {
    const approvalPolicy = parseApprovalPolicy(this.options.approvalPolicy);
    const sandbox = parseSandboxMode(this.options.sandbox);
    const threadStartParams: ThreadStartParams = {
      approvalPolicy,
      baseInstructions: input.instructions,
      cwd: this.options.cwd,
      developerInstructions: input.developerRolePrompt,
      ephemeral: true,
      experimentalRawEvents: false,
      model: this.options.model,
      personality: "friendly",
      persistExtendedHistory: false,
      sandbox,
    };

    if (input.config) {
      threadStartParams.config = normalizeThreadStartConfig(input.config);
    }

    const result = await this.rpcClient.request("thread/start", threadStartParams);
    return extractThreadId(result);
  }

  async startTurn(threadId: string, prompt: string): Promise<StartedTurn> {
    const tracker = createTurnTracker();
    const unbind = this.rpcClient.onNotification((notification) => {
      handleTurnNotification(notification, tracker);
    });

    try {
      const params: TurnStartParams = {
        input: [toTextUserInput(prompt)],
        threadId,
      };
      const result = await this.rpcClient.request("turn/start", params);
      const turnId = extractTurnId(result);

      const completion = waitForTurnCompletion({
        onTimeout: async () => {
          await this.interruptTurn(threadId, turnId);
        },
        timeoutMs: this.options.timeoutMs,
        tracker,
      }).finally(() => {
        unbind();
      });

      return {
        completion,
        turnId,
      };
    } catch (error) {
      unbind();
      throw error;
    }
  }

  async steerTurn(threadId: string, expectedTurnId: string, prompt: string): Promise<void> {
    const params: TurnSteerParams = {
      expectedTurnId,
      input: [toTextUserInput(prompt)],
      threadId,
    };

    await this.rpcClient.request("turn/steer", params);
  }

  close(): void {
    this.rpcClient.close();
  }

  private async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const interruptRequest = this.rpcClient
      .request("turn/interrupt", { threadId, turnId })
      .catch(() => undefined);

    await Promise.race([interruptRequest, wait(500)]);
  }
}

function parseApprovalPolicy(value: unknown): AskForApproval {
  if (isApprovalPolicy(value)) {
    return value;
  }

  throw new Error(`Invalid approvalPolicy: ${String(value)}`);
}

function parseSandboxMode(value: unknown): SandboxMode {
  if (isSandboxMode(value)) {
    return value;
  }

  throw new Error(`Invalid sandbox mode: ${String(value)}`);
}

function toTextUserInput(prompt: string): UserInput {
  return {
    text: prompt,
    text_elements: [],
    type: "text",
  };
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
