import { describe, expect, it, vi } from "vitest";

import { AgentRuntimeRestartLimitError, AgentRuntimeSupervisor } from "./agent-runtime-supervisor";
import type { SupervisedAgentRuntime } from "./agent-runtime-supervisor";

type StartRuntime = (
	signal: AbortSignal,
	onFailure: (error: Error) => void,
) => Promise<SupervisedAgentRuntime>;

function createRuntime(close: () => Promise<void> = async () => undefined): SupervisedAgentRuntime {
	return {
		archiveThread: async () => undefined,
		close,
		deleteThread: async () => undefined,
		interruptTurn: async () => undefined,
		listArchivedThreads: async () => ({ data: [] }),
		listModels: async () => [],
		openThread: async () => "thread-1",
		startTurn: async () => {
			throw new Error("unused");
		},
		steerTurn: async () => undefined,
	};
}

function createSupervisor(
	policy: ConstructorParameters<typeof AgentRuntimeSupervisor>[0],
	startRuntime: StartRuntime,
	options: {
		delay?: (milliseconds: number) => Promise<void>;
		onFailure?: (error: Error) => void;
	} = {},
): AgentRuntimeSupervisor {
	return new AgentRuntimeSupervisor(policy, {
		delay: options.delay ?? (async () => undefined),
		now: () => 1_000,
		onFailure: options.onFailure ?? (() => undefined),
		onFatal: () => undefined,
		startRuntime,
	});
}

describe("AgentRuntimeSupervisor", () => {
	it("初期化失敗を指数バックオフして再試行する", async () => {
		const delays: number[] = [];
		const startRuntime = vi
			.fn<StartRuntime>()
			.mockRejectedValueOnce(new Error("spawn failed"))
			.mockRejectedValueOnce(new Error("initialize failed"))
			.mockResolvedValue(createRuntime());
		const supervisor = createSupervisor(
			{ initialDelayMs: 1_000, limit: 5, maxDelayMs: 30_000, windowMs: 300_000 },
			startRuntime,
			{
				delay: async (milliseconds) => {
					delays.push(milliseconds);
				},
			},
		);

		await supervisor.start();

		expect(startRuntime).toHaveBeenCalledTimes(3);
		expect(delays).toEqual([1_000, 2_000]);
	});

	it("window 内で上限を超えた次の障害を fatal にする", async () => {
		const startRuntime = vi.fn<StartRuntime>().mockRejectedValue(new Error("always fails"));
		const supervisor = createSupervisor(
			{ initialDelayMs: 100, limit: 2, maxDelayMs: 1_000, windowMs: 10_000 },
			startRuntime,
		);

		await expect(supervisor.start()).rejects.toBeInstanceOf(AgentRuntimeRestartLimitError);
		expect(startRuntime).toHaveBeenCalledTimes(3);
	});

	it("起動中に通知された障害では再起動せず、起動失敗として再試行する", async () => {
		const failure = new Error("initialize failed");
		const startRuntime = vi
			.fn<StartRuntime>()
			.mockImplementationOnce(async (_signal, onFailure) => {
				onFailure(failure);
				throw failure;
			})
			.mockResolvedValueOnce(createRuntime());
		const failures: Error[] = [];
		const supervisor = createSupervisor(
			{ initialDelayMs: 0, limit: 2, maxDelayMs: 1_000, windowMs: 10_000 },
			startRuntime,
			{ onFailure: (error) => failures.push(error) },
		);

		await supervisor.start();

		expect(startRuntime).toHaveBeenCalledTimes(2);
		expect(failures).toEqual([failure]);
	});

	it("READY 世代の connection failure も onFailure で通知する", async () => {
		let reportFailure: ((error: Error) => void) | undefined;
		const startRuntime = vi
			.fn<StartRuntime>()
			.mockImplementationOnce(async (_signal, onFailure) => {
				reportFailure = onFailure;
				return createRuntime();
			})
			.mockResolvedValueOnce(createRuntime());
		const failures: Error[] = [];
		const supervisor = createSupervisor(
			{ initialDelayMs: 0, limit: 2, maxDelayMs: 1_000, windowMs: 10_000 },
			startRuntime,
			{ onFailure: (error) => failures.push(error) },
		);
		await supervisor.start();
		const failure = new Error("connection lost");

		if (reportFailure === undefined) {
			throw new Error("Failure handler was not registered.");
		}
		reportFailure(failure);
		await vi.waitFor(() => expect(startRuntime).toHaveBeenCalledTimes(2));

		expect(failures).toEqual([failure]);
	});

	it("起動前、接続中、障害後の再起動中、close後の状態を返す", async () => {
		let reportFailure: ((error: Error) => void) | undefined;
		const restartDelay = Promise.withResolvers<void>();
		const startRuntime = vi
			.fn<StartRuntime>()
			.mockImplementationOnce(async (_signal, onFailure) => {
				reportFailure = onFailure;
				return createRuntime();
			})
			.mockResolvedValueOnce(createRuntime());
		const supervisor = createSupervisor(
			{ initialDelayMs: 0, limit: 3, maxDelayMs: 1_000, windowMs: 10_000 },
			startRuntime,
			{ delay: async () => await restartDelay.promise },
		);
		expect(supervisor.status()).toEqual({
			lastFailure: null,
			restartLimit: 3,
			restartsInWindow: 0,
			state: "starting",
		});
		await supervisor.start();
		expect(supervisor.status().state).toBe("ready");

		reportFailure?.(new Error("connection lost"));
		expect(supervisor.status()).toEqual({
			lastFailure: { at: new Date(1_000).toISOString(), message: "connection lost" },
			restartLimit: 3,
			restartsInWindow: 1,
			state: "restarting",
		});
		restartDelay.resolve();
		await vi.waitFor(() => expect(supervisor.status().state).toBe("ready"));

		await supervisor.close();
		expect(supervisor.status().state).toBe("closed");
	});

	it("再起動上限を超えたらfatalを返す", async () => {
		const supervisor = createSupervisor(
			{ initialDelayMs: 0, limit: 1, maxDelayMs: 1_000, windowMs: 10_000 },
			vi.fn<StartRuntime>().mockRejectedValue(new Error("always fails")),
		);

		await expect(supervisor.start()).rejects.toBeInstanceOf(AgentRuntimeRestartLimitError);
		expect(supervisor.status()).toMatchObject({ restartsInWindow: 1, state: "fatal" });
	});

	it("旧runtimeのclose完了後にreplacementを起動する", async () => {
		let reportFailure: ((error: Error) => void) | undefined;
		const closing = Promise.withResolvers<void>();
		const startRuntime = vi
			.fn<StartRuntime>()
			.mockImplementationOnce(async (_signal, onFailure) => {
				reportFailure = onFailure;
				return createRuntime(async () => await closing.promise);
			})
			.mockResolvedValueOnce(createRuntime());
		const supervisor = createSupervisor(
			{ initialDelayMs: 0, limit: 2, maxDelayMs: 1_000, windowMs: 10_000 },
			startRuntime,
		);
		await supervisor.start();

		if (reportFailure === undefined) throw new Error("Failure handler was not registered.");
		reportFailure(new Error("connection lost"));
		await Promise.resolve();
		expect(startRuntime).toHaveBeenCalledOnce();

		closing.resolve();
		await vi.waitFor(() => expect(startRuntime).toHaveBeenCalledTimes(2));
	});

	it("close時に初期化中runtimeへabort signalを渡して待機を終える", async () => {
		const started = Promise.withResolvers<void>();
		const startRuntime = vi.fn<StartRuntime>(async (signal) => {
			started.resolve();
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("startup aborted")), {
					once: true,
				});
			});
			return createRuntime();
		});
		const supervisor = createSupervisor(
			{ initialDelayMs: 0, limit: 2, maxDelayMs: 1_000, windowMs: 10_000 },
			startRuntime,
		);
		const startup = supervisor.start();
		await started.promise;

		await supervisor.close();

		await expect(startup).rejects.toThrow("closed");
		expect(startRuntime.mock.calls[0]?.[0].aborted).toBe(true);
	});

	it("close後に起動完了したruntimeを採用せずに閉じる", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const runtimeClose = vi.fn(async () => undefined);
		const startRuntime = vi.fn<StartRuntime>(async () => {
			started.resolve();
			await release.promise;
			return createRuntime(runtimeClose);
		});
		const supervisor = createSupervisor(
			{ initialDelayMs: 0, limit: 2, maxDelayMs: 1_000, windowMs: 10_000 },
			startRuntime,
		);
		const startup = supervisor.start();
		await started.promise;

		const closing = supervisor.close();
		release.resolve();
		await closing;

		await expect(startup).rejects.toThrow("closed");
		expect(runtimeClose).toHaveBeenCalledOnce();
		expect(startRuntime).toHaveBeenCalledOnce();
	});
});
