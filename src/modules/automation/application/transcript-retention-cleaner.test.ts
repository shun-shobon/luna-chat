import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import type { LoggerPort } from "../../observability/ports/logger-port";
import type { AutomationClockPort, AutomationTimerHandle } from "../ports/automation-clock-port";
import type { TranscriptPrunerPort } from "../ports/transcript-pruner-port";
import { TranscriptRetentionCleaner } from "./transcript-retention-cleaner";

const NOW = new Date("2026-11-14T00:00:00.000Z");

describe("TranscriptRetentionCleaner", () => {
	it("起動直後に現在時刻と保持期間で記録を削除し、完了後に次回を予約する", async () => {
		const pruner = createPruner();
		const clock = new FakeClock(NOW);
		const cleaner = createCleaner({ clock, pruner });

		cleaner.start();
		await cleaner.drain();

		expect(pruner.prune).toHaveBeenCalledExactlyOnceWith(NOW, 100_000);
		expect(clock.delays).toEqual([1_000]);
		await clock.fireNext();
		await cleaner.drain();
		expect(pruner.prune).toHaveBeenCalledTimes(2);
		expect(clock.delays).toEqual([1_000]);
	});

	it("削除が終わるまで次回を予約しない", async () => {
		const pruning = createDeferred<undefined>();
		const pruner = createPruner(async () => await pruning.promise);
		const clock = new FakeClock(NOW);
		const cleaner = createCleaner({ clock, pruner });

		cleaner.start();
		await Promise.resolve();
		expect(clock.delays).toEqual([]);
		pruning.resolve(undefined);
		await cleaner.drain();

		expect(clock.delays).toEqual([1_000]);
	});

	it("削除の失敗を記録し、次回を予約して再試行する", async () => {
		const failure = new Error("prune failed");
		const pruner = createPruner();
		pruner.prune.mockRejectedValueOnce(failure);
		const clock = new FakeClock(NOW);
		const logger = { log: vi.fn<LoggerPort["log"]>() };
		const cleaner = createCleaner({ clock, logger, pruner });

		cleaner.start();
		await cleaner.drain();

		expect(logger.log).toHaveBeenCalledWith(
			"error",
			"automation.transcript_retention.prune_failed",
			{},
			{ error: failure },
		);
		expect(clock.delays).toEqual([1_000]);
		await clock.fireNext();
		await cleaner.drain();
		expect(pruner.prune).toHaveBeenCalledTimes(2);
	});

	it("停止後は予約を取り消し、実行中の削除をdrainで待つが次回を予約しない", async () => {
		const pruning = createDeferred<undefined>();
		const pruner = createPruner();
		const clock = new FakeClock(NOW);
		const cleaner = createCleaner({ clock, pruner });
		cleaner.start();
		await cleaner.drain();

		pruner.prune.mockImplementationOnce(async () => await pruning.promise);
		await clock.fireNext();
		cleaner.stopIntake();
		let drained = false;
		const draining = cleaner.drain().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		pruning.resolve(undefined);
		await draining;

		expect(clock.delays).toEqual([]);
	});

	it("予約中に停止すると予約を取り消す", async () => {
		const clock = new FakeClock(NOW);
		const cleaner = createCleaner({ clock, pruner: createPruner() });
		cleaner.start();
		await cleaner.drain();
		expect(clock.delays).toEqual([1_000]);

		cleaner.stopIntake();

		expect(clock.delays).toEqual([]);
	});
});

function createCleaner(input: {
	clock: AutomationClockPort;
	logger?: LoggerPort;
	pruner: TranscriptPrunerPort;
}): TranscriptRetentionCleaner {
	return new TranscriptRetentionCleaner({
		cleanupIntervalMs: 1_000,
		clock: input.clock,
		logger: input.logger ?? { log: vi.fn() },
		pruner: input.pruner,
		retentionMs: 100_000,
	});
}

function createPruner(implementation: TranscriptPrunerPort["prune"] = async () => undefined): {
	prune: Mock<TranscriptPrunerPort["prune"]>;
} {
	return { prune: vi.fn(implementation) };
}

class FakeClock implements AutomationClockPort {
	readonly #timers: Array<{
		callback: () => void;
		delayMs: number;
		handle: AutomationTimerHandle;
	}> = [];
	readonly #now: Date;

	constructor(now: Date) {
		this.#now = now;
	}

	get delays(): number[] {
		return this.#timers.map((timer) => timer.delayMs);
	}

	now(): Date {
		return this.#now;
	}

	setTimer(delayMs: number, callback: () => void): AutomationTimerHandle {
		const handle = {
			cancel: () => {
				const index = this.#timers.findIndex((timer) => timer.handle === handle);
				if (index >= 0) this.#timers.splice(index, 1);
			},
		};
		this.#timers.push({ callback, delayMs, handle });
		return handle;
	}

	async fireNext(): Promise<void> {
		const timer = this.#timers.shift();
		if (timer === undefined) throw new Error("No timer is scheduled.");
		timer.callback();
		await Promise.resolve();
	}
}

function createDeferred<Value>(): {
	promise: Promise<Value>;
	resolve: (value: Value) => void;
} {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}
