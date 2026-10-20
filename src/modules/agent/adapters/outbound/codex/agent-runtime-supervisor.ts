import { setTimeout as delay } from "node:timers/promises";

import type {
	AgentRuntimePort,
	AgentRuntimeStatus,
	AgentThreadInput,
	AgentTurnRequest,
	StartedAgentTurn,
	ThreadId,
	TurnId,
} from "../../../ports/outbound/agent-runtime-port";

type AgentRestartPolicy = {
	initialDelayMs: number;
	limit: number;
	maxDelayMs: number;
	windowMs: number;
};

export type SupervisedAgentRuntime = AgentRuntimePort & { close(): Promise<void> };

type AgentRuntimeSupervisorDependencies = {
	delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
	now?: () => number;
	onFailure(error: Error): void;
	onFatal(error: Error): void;
	startRuntime: (
		signal: AbortSignal,
		onFailure: (error: Error) => void,
	) => Promise<SupervisedAgentRuntime>;
};

export class AgentRuntimeRestartLimitError extends Error {
	public constructor(options?: ErrorOptions) {
		super("Codex app-server restart limit was exceeded.", options);
		this.name = "AgentRuntimeRestartLimitError";
	}
}

export class AgentRuntimeSupervisor implements AgentRuntimePort {
	readonly #dependencies: AgentRuntimeSupervisorDependencies;
	readonly #delay: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
	readonly #now: () => number;
	readonly #policy: AgentRestartPolicy;
	readonly #restartTimestamps: number[] = [];
	#bootPromise: Promise<AgentRuntimePort> | undefined;
	readonly #closeController = new AbortController();
	#closed = false;
	#fatalError: Error | undefined;
	#lastFailure: Readonly<{ at: number; message: string }> | undefined;
	#runtime: SupervisedAgentRuntime | undefined;
	#runtimeClosePromise: Promise<void> | undefined;

	public constructor(policy: AgentRestartPolicy, dependencies: AgentRuntimeSupervisorDependencies) {
		this.#policy = policy;
		this.#dependencies = dependencies;
		this.#now = dependencies.now ?? Date.now;
		this.#delay = dependencies.delay ?? defaultDelay;
	}

	public status(): AgentRuntimeStatus {
		const now = this.#now();
		return {
			lastFailure:
				this.#lastFailure === undefined
					? null
					: {
							at: new Date(this.#lastFailure.at).toISOString(),
							message: this.#lastFailure.message,
						},
			restartLimit: this.#policy.limit,
			restartsInWindow: this.#restartTimestamps.filter(
				(timestamp) => now - timestamp < this.#policy.windowMs,
			).length,
			state: this.#state(),
		};
	}

	#state(): AgentRuntimeStatus["state"] {
		if (this.#closed) return "closed";
		if (this.#fatalError !== undefined) return "fatal";
		if (this.#runtime !== undefined) return "ready";
		return this.#lastFailure === undefined ? "starting" : "restarting";
	}

	public async archiveThread(threadId: ThreadId): Promise<void> {
		await (await this.#getRuntime()).archiveThread(threadId);
	}

	public async close(): Promise<void> {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		this.#closeController.abort();
		const runtime = this.#runtime;
		this.#runtime = undefined;
		const bootPromise = this.#bootPromise;
		const runtimeClosePromise = this.#runtimeClosePromise;
		const closeResultsPromise = Promise.allSettled([
			...(runtime === undefined ? [] : [runtime.close()]),
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
		await (await this.#getRuntime()).deleteThread(threadId);
	}

	public async interruptTurn(threadId: ThreadId, turnId: TurnId): Promise<void> {
		await (await this.#getRuntime()).interruptTurn(threadId, turnId);
	}

	public async listArchivedThreads(
		cursor?: string,
	): ReturnType<AgentRuntimePort["listArchivedThreads"]> {
		return await (await this.#getRuntime()).listArchivedThreads(cursor);
	}

	public async listModels(): ReturnType<AgentRuntimePort["listModels"]> {
		return await (await this.#getRuntime()).listModels();
	}

	public async openThread(input: AgentThreadInput): Promise<ThreadId> {
		return await (await this.#getRuntime()).openThread(input);
	}

	public async start(): Promise<void> {
		await this.#getRuntime();
	}

	public async startTurn(threadId: ThreadId, request: AgentTurnRequest): Promise<StartedAgentTurn> {
		return await (await this.#getRuntime()).startTurn(threadId, request);
	}

	public async steerTurn(threadId: ThreadId, turnId: TurnId, input: string): Promise<void> {
		await (await this.#getRuntime()).steerTurn(threadId, turnId, input);
	}

	async #boot(): Promise<AgentRuntimePort> {
		while (!this.#closed && this.#fatalError === undefined) {
			try {
				let runtime: SupervisedAgentRuntime | undefined;
				runtime = await this.#dependencies.startRuntime(this.#closeController.signal, (error) => {
					// A failure during startup rejects startRuntime and is retried by this loop instead.
					if (runtime !== undefined) this.#handleRuntimeFailure(runtime, error);
				});
				if (this.#closeController.signal.aborted) {
					await runtime.close();
					break;
				}
				this.#runtime = runtime;
				return runtime;
			} catch (error: unknown) {
				if (this.#closeController.signal.aborted) {
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
		if (this.#runtime !== undefined) {
			return this.#runtime;
		}
		this.#bootPromise ??= this.#boot().finally(() => {
			this.#bootPromise = undefined;
		});
		return await this.#bootPromise;
	}

	#handleRuntimeFailure(runtime: SupervisedAgentRuntime, error: Error): void {
		if (this.#runtime !== runtime) {
			return;
		}
		this.#runtime = undefined;
		const closePromise = runtime.close();
		this.#runtimeClosePromise = closePromise;
		void closePromise
			.catch(() => undefined)
			.finally(() => {
				if (this.#runtimeClosePromise === closePromise) this.#runtimeClosePromise = undefined;
			});
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
		this.#dependencies.onFailure(cause);
		const now = this.#now();
		this.#lastFailure = { at: now, message: cause.message };
		let oldestRestart = this.#restartTimestamps[0];
		while (oldestRestart !== undefined && now - oldestRestart >= this.#policy.windowMs) {
			this.#restartTimestamps.shift();
			oldestRestart = this.#restartTimestamps[0];
		}
		if (this.#restartTimestamps.length >= this.#policy.limit) {
			const fatalError = new AgentRuntimeRestartLimitError({ cause });
			this.#fatalError = fatalError;
			this.#dependencies.onFatal(fatalError);
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

async function defaultDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	await delay(milliseconds, undefined, { signal });
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error("Failed to start Codex app-server.");
}
