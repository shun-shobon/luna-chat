import type { AgentRuntimePort } from "../../../ports/outbound/agent-runtime-port";

import { CodexAgentRuntime } from "./codex-agent-runtime";
import { startCodexStdioProcess, type StartCodexStdioProcessOptions } from "./codex-stdio-process";
import { JsonRpcConnection } from "./json-rpc-connection";

export interface ManagedAgentRuntime {
  close(): Promise<void>;
  onFailure(handler: (error: Error) => void): () => void;
  port: AgentRuntimePort;
}

type StartManagedCodexRuntimeOptions = StartCodexStdioProcessOptions & {
  onRpcEvent?: ConstructorParameters<typeof JsonRpcConnection>[2];
  rpcTimeoutMs: number;
};

export async function startManagedCodexRuntime(
  options: StartManagedCodexRuntimeOptions,
): Promise<ManagedAgentRuntime> {
  const transport = startCodexStdioProcess(options);
  const connection = new JsonRpcConnection(transport, options.rpcTimeoutMs, options.onRpcEvent);

  try {
    const port = await CodexAgentRuntime.initialize(connection);
    return {
      close: () => connection.close(),
      onFailure: (handler) => connection.onFatal(handler),
      port,
    };
  } catch (error: unknown) {
    await connection.close();
    throw error;
  }
}
