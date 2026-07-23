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
  signal?: AbortSignal;
};

export async function startManagedCodexRuntime(
  options: StartManagedCodexRuntimeOptions,
): Promise<ManagedAgentRuntime> {
  const transport = startCodexStdioProcess(options);
  const connection = new JsonRpcConnection(transport, options.rpcTimeoutMs, options.onRpcEvent);
  const abort = () => {
    void connection.close();
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    options.signal?.throwIfAborted();
    const port = await CodexAgentRuntime.initialize(connection);
    options.signal?.throwIfAborted();
    options.signal?.removeEventListener("abort", abort);
    return {
      close: () => connection.close(),
      onFailure: (handler) => connection.onFatal(handler),
      port,
    };
  } catch (error: unknown) {
    options.signal?.removeEventListener("abort", abort);
    await connection.close();
    throw error;
  }
}
