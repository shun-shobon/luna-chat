import type { ThreadStartParams } from "../../../../../generated/codex/v2/ThreadStartParams";
import type { TurnStartParams } from "../../../../../generated/codex/v2/TurnStartParams";
import type { TurnSteerParams } from "../../../../../generated/codex/v2/TurnSteerParams";
import type { UserInput } from "../../../../../generated/codex/v2/UserInput";
import type { StartedTurn, TurnObserver } from "../../../ports/outbound/ai-runtime-port";

import {
  createJsonRpcClient,
  extractThreadId,
  extractTurnId,
  normalizeThreadStartConfig,
  CLIENT_INFO,
} from "./json-rpc-client";
import { startStdioProcess, type StdioProcessOptions } from "./stdio-process";
import {
  bindTrackerToTurn,
  createTurnTracker,
  handleTurnNotification,
  waitForTurnCompletion,
} from "./turn-result-collector";

type CodexAiRuntimeOptions = StdioProcessOptions;

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
    const threadStartParams: ThreadStartParams = {
      approvalPolicy: "never",
      baseInstructions: input.instructions,
      cwd: this.options.cwd,
      developerInstructions: input.developerRolePrompt,
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    };

    if (input.config) {
      threadStartParams.config = normalizeThreadStartConfig(input.config);
    }

    const result = await this.rpcClient.request("thread/start", threadStartParams);
    return extractThreadId(result);
  }

  async startTurn(
    threadId: string,
    prompt: string,
    observer: TurnObserver | undefined,
    options: {
      timeoutMs: number;
    },
  ): Promise<StartedTurn> {
    const tracker = createTurnTracker({ threadId });
    const unbind = this.rpcClient.onNotification((notification) => {
      handleTurnNotification(notification, tracker, observer);
    });

    try {
      const params: TurnStartParams = {
        input: [toTextUserInput(prompt)],
        threadId,
      };
      const result = await this.rpcClient.request("turn/start", params);
      const turnId = extractTurnId(result);
      bindTrackerToTurn(tracker, turnId);

      const completion = waitForTurnCompletion({
        onTimeout: async () => {
          await this.interruptTurn(threadId, turnId);
        },
        timeoutMs: options.timeoutMs,
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

  async close(): Promise<void> {
    await this.rpcClient.close();
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const interruptRequest = this.rpcClient
      .request("turn/interrupt", { threadId, turnId })
      .catch(() => undefined);

    await Promise.race([interruptRequest, wait(500)]);
  }
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
