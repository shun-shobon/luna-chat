import type {
  AgentRuntimePort,
  AgentTurnRequest,
  StartedAgentTurn,
  ThreadId,
  TurnId,
} from "../../../ports/outbound/agent-runtime-port";

import type { ManagedAgentRuntime } from "./managed-codex-runtime";

type AgentRestartPolicy = {
  initialDelayMs: number;
  limit: number;
  maxDelayMs: number;
  windowMs: number;
};

type AgentRuntimeSupervisorDependencies = {
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  startRuntime: (signal: AbortSignal) => Promise<ManagedAgentRuntime>;
};

export class AgentRuntimeRestartLimitError extends Error {
  public constructor(options?: ErrorOptions) {
    super("Codex app-server restart limit was exceeded.", options);
    this.name = "AgentRuntimeRestartLimitError";
  }
}

export class AgentRuntimeSupervisor implements AgentRuntimePort {
  readonly #delay: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #fatalHandlers = new Set<(error: Error) => void>();
  readonly #failureHandlers = new Set<(error: Error) => void>();
  readonly #now: () => number;
  readonly #policy: AgentRestartPolicy;
  readonly #restartTimestamps: number[] = [];
  readonly #startRuntime: (signal: AbortSignal) => Promise<ManagedAgentRuntime>;
  #bootPromise: Promise<AgentRuntimePort> | undefined;
  readonly #closeController = new AbortController();
  #closed = false;
  #fatalError: Error | undefined;
  #managed: ManagedAgentRuntime | undefined;
  #runtimeClosePromise: Promise<void> | undefined;
  #runtimeGeneration = 0;

  public constructor(policy: AgentRestartPolicy, dependencies: AgentRuntimeSupervisorDependencies) {
    validatePolicy(policy);
    this.#policy = policy;
    this.#startRuntime = dependencies.startRuntime;
    this.#now = dependencies.now ?? Date.now;
    this.#delay = dependencies.delay ?? defaultDelay;
  }

  public async archiveThread(threadId: ThreadId): Promise<void> {
    return await (await this.#getRuntime()).archiveThread(threadId);
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#runtimeGeneration += 1;
    this.#closeController.abort();
    const managed = this.#managed;
    this.#managed = undefined;
    const bootPromise = this.#bootPromise;
    const runtimeClosePromise = this.#runtimeClosePromise;
    const closeResultsPromise = Promise.allSettled([
      ...(managed === undefined ? [] : [managed.close()]),
      ...(runtimeClosePromise === undefined ? [] : [runtimeClosePromise]),
    ]);
    const [closeResults] = await Promise.all([
      closeResultsPromise,
      bootPromise?.catch(() => undefined) ?? Promise.resolve(),
    ]);
    const closeFailure = closeResults.find((result) => result.status === "rejected");
    if (closeFailure?.status === "rejected") throw closeFailure.reason;
  }

  public async deleteThread(threadId: ThreadId): Promise<void> {
    return await (await this.#getRuntime()).deleteThread(threadId);
  }

  public async interruptTurn(threadId: ThreadId, turnId: TurnId): Promise<void> {
    return await (await this.#getRuntime()).interruptTurn(threadId, turnId);
  }

  public async listThreads(input?: {
    archived?: boolean;
    cursor?: string;
    limit?: number;
  }): ReturnType<AgentRuntimePort["listThreads"]> {
    return await (await this.#getRuntime()).listThreads(input);
  }

  public onFatal(handler: (error: Error) => void): () => void {
    if (this.#fatalError !== undefined) {
      handler(this.#fatalError);
      return () => undefined;
    }
    this.#fatalHandlers.add(handler);
    return () => this.#fatalHandlers.delete(handler);
  }

  public onFailure(handler: (error: Error) => void): () => void {
    this.#failureHandlers.add(handler);
    return () => this.#failureHandlers.delete(handler);
  }

  public async openThread(input: {
    baseInstructions: string;
    config: Record<string, unknown>;
    cwd: string;
    developerInstructions: string;
  }): Promise<ThreadId> {
    return await (await this.#getRuntime()).openThread(input);
  }

  public async start(): Promise<void> {
    await this.#getRuntime();
  }

  public async startTurn(threadId: ThreadId, request: AgentTurnRequest): Promise<StartedAgentTurn> {
    return await (await this.#getRuntime()).startTurn(threadId, request);
  }

  public async steerTurn(threadId: ThreadId, turnId: TurnId, input: string): Promise<void> {
    return await (await this.#getRuntime()).steerTurn(threadId, turnId, input);
  }

  async #boot(): Promise<AgentRuntimePort> {
    while (!this.#closed && this.#fatalError === undefined) {
      const generation = ++this.#runtimeGeneration;
      try {
        const managed = await this.#startRuntime(this.#closeController.signal);
        if (this.#closed || generation !== this.#runtimeGeneration) {
          await managed.close();
          throw new Error("Codex runtime startup was superseded.");
        }
        let accepted = false;
        let startupFailure: Error | undefined;
        managed.onFailure((error) => {
          if (!accepted) {
            startupFailure = error;
            return;
          }
          this.#handleRuntimeFailure(generation, managed, error);
        });
        if (startupFailure !== undefined) {
          await managed.close();
          throw startupFailure;
        }
        this.#managed = managed;
        accepted = true;
        return managed.port;
      } catch (error: unknown) {
        if (this.#closed || generation !== this.#runtimeGeneration) {
          break;
        }
        const restartDelay = this.#registerRestart(toError(error));
        if (restartDelay === undefined) {
          break;
        }
        await this.#delay(restartDelay, this.#closeController.signal);
      }
    }
    this.#assertAvailable();
    throw new Error("Codex runtime supervisor stopped before startup completed.");
  }

  async #getRuntime(): Promise<AgentRuntimePort> {
    this.#assertAvailable();
    if (this.#managed !== undefined) {
      return this.#managed.port;
    }
    if (this.#bootPromise === undefined) {
      this.#bootPromise = this.#boot().finally(() => {
        this.#bootPromise = undefined;
      });
    }
    return await this.#bootPromise;
  }

  #handleRuntimeFailure(generation: number, managed: ManagedAgentRuntime, error: Error): void {
    if (this.#closed || generation !== this.#runtimeGeneration || this.#managed !== managed) {
      return;
    }
    this.#managed = undefined;
    this.#runtimeGeneration += 1;
    const closePromise = managed.close();
    let trackedClosePromise: Promise<void>;
    trackedClosePromise = closePromise.finally(() => {
      if (this.#runtimeClosePromise === trackedClosePromise) this.#runtimeClosePromise = undefined;
    });
    this.#runtimeClosePromise = trackedClosePromise;
    void this.#runtimeClosePromise.catch(() => undefined);
    const restartDelay = this.#registerRestart(error);
    if (restartDelay === undefined) {
      return;
    }
    this.#bootPromise = closePromise
      .catch(() => undefined)
      .then(() => this.#delay(restartDelay, this.#closeController.signal))
      .then(() => this.#boot())
      .finally(() => {
        this.#bootPromise = undefined;
      });
    void this.#bootPromise.catch(() => undefined);
  }

  #registerRestart(cause: Error): number | undefined {
    for (const handler of this.#failureHandlers) {
      handler(cause);
    }
    const now = this.#now();
    let oldestRestart = this.#restartTimestamps[0];
    while (oldestRestart !== undefined && now - oldestRestart >= this.#policy.windowMs) {
      this.#restartTimestamps.shift();
      oldestRestart = this.#restartTimestamps[0];
    }
    if (this.#restartTimestamps.length >= this.#policy.limit) {
      const fatalError = new AgentRuntimeRestartLimitError({ cause });
      this.#fatalError = fatalError;
      for (const handler of this.#fatalHandlers) {
        handler(fatalError);
      }
      return undefined;
    }
    this.#restartTimestamps.push(now);
    const exponent = this.#restartTimestamps.length - 1;
    return Math.min(this.#policy.initialDelayMs * 2 ** exponent, this.#policy.maxDelayMs);
  }

  #assertAvailable(): void {
    if (this.#fatalError !== undefined) {
      throw this.#fatalError;
    }
    if (this.#closed) {
      throw new Error("Codex runtime supervisor is closed.");
    }
  }
}

function validatePolicy(policy: AgentRestartPolicy): void {
  for (const [key, value] of Object.entries({
    limit: policy.limit,
    maxDelayMs: policy.maxDelayMs,
    windowMs: policy.windowMs,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive safe integer.`);
    }
  }
  if (!Number.isSafeInteger(policy.initialDelayMs) || policy.initialDelayMs < 0) {
    throw new Error("initialDelayMs must be a non-negative safe integer.");
  }
  if (policy.initialDelayMs > policy.maxDelayMs) {
    throw new Error("initialDelayMs must not exceed maxDelayMs.");
  }
}

async function defaultDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let remaining = milliseconds;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Delay was aborted."));
    };
    const schedule = () => {
      const chunk = Math.min(remaining, MAXIMUM_TIMEOUT_MS);
      timeout = setTimeout(() => {
        remaining -= chunk;
        if (remaining > 0) schedule();
        else {
          signal?.removeEventListener("abort", abort);
          resolve();
        }
      }, chunk);
    };
    if (signal?.aborted === true) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    schedule();
  });
}

const MAXIMUM_TIMEOUT_MS = 2_147_483_647;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Failed to start Codex app-server.");
}
