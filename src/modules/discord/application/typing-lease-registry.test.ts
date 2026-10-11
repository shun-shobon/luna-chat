import { afterEach, describe, expect, it, vi } from "vitest";

import { TypingLeaseRegistry } from "./typing-lease-registry";

afterEach(() => {
	vi.useRealTimers();
});

describe("TypingLeaseRegistry", () => {
	it("即時送信後に更新し、owner単位で停止する", async () => {
		vi.useFakeTimers();
		const refresh = vi.fn(async () => undefined);
		const registry = new TypingLeaseRegistry(1_000, vi.fn());

		await registry.start({ ownerId: "turn-1", channelId: "100" }, refresh);
		await vi.advanceTimersByTimeAsync(2_000);
		registry.releaseOwner("turn-1");
		await vi.advanceTimersByTimeAsync(2_000);

		expect(refresh).toHaveBeenCalledTimes(3);
	});

	it("同じownerとchannelのleaseを重複作成しない", async () => {
		const first = vi.fn(async () => undefined);
		const second = vi.fn(async () => undefined);
		const registry = new TypingLeaseRegistry(1_000, vi.fn());
		const context = { ownerId: "turn-1", channelId: "100" };

		await registry.start(context, first);
		await registry.start(context, second);
		registry.releaseAll();

		expect(first).toHaveBeenCalledOnce();
		expect(second).not.toHaveBeenCalled();
	});

	it("同じleaseの並行startを一つのintervalへまとめる", async () => {
		vi.useFakeTimers();
		const firstRefresh = deferred<void>();
		const first = vi.fn(async () => await firstRefresh.promise);
		const second = vi.fn(async () => undefined);
		const registry = new TypingLeaseRegistry(1_000, vi.fn());
		const context = { ownerId: "turn-1", channelId: "100" };

		const firstStart = registry.start(context, first);
		const secondStart = registry.start(context, second);
		firstRefresh.resolve(undefined);
		await Promise.all([firstStart, secondStart]);
		await vi.advanceTimersByTimeAsync(1_000);
		registry.releaseAll();
		await vi.advanceTimersByTimeAsync(1_000);

		expect(first).toHaveBeenCalledTimes(2);
		expect(second).not.toHaveBeenCalled();
	});

	it("pending start中のreleaseAllでinterval作成を中止する", async () => {
		vi.useFakeTimers();
		const refreshing = deferred<void>();
		const refresh = vi.fn(async () => await refreshing.promise);
		const registry = new TypingLeaseRegistry(1_000, vi.fn());
		const starting = registry.start({ ownerId: "turn-1", channelId: "100" }, refresh);

		registry.releaseAll();
		refreshing.resolve(undefined);
		await starting;
		await vi.advanceTimersByTimeAsync(2_000);

		expect(refresh).toHaveBeenCalledOnce();
	});

	it("pending start中のstopで対象interval作成を中止する", async () => {
		vi.useFakeTimers();
		const refreshing = deferred<void>();
		const refresh = vi.fn(async () => await refreshing.promise);
		const registry = new TypingLeaseRegistry(1_000, vi.fn());
		const context = { ownerId: "turn-1", channelId: "100" };
		const starting = registry.start(context, refresh);

		registry.stop(context);
		refreshing.resolve(undefined);
		await starting;
		await vi.advanceTimersByTimeAsync(2_000);

		expect(refresh).toHaveBeenCalledOnce();
	});

	it("初回送信の失敗後は同じleaseを再開始できる", async () => {
		const registry = new TypingLeaseRegistry(1_000, vi.fn());
		const context = { ownerId: "turn-1", channelId: "100" };
		const retry = vi.fn(async () => undefined);

		await expect(
			registry.start(context, async () => {
				throw new Error("typing failed");
			}),
		).rejects.toThrow("typing failed");
		await registry.start(context, retry);
		registry.releaseAll();

		expect(retry).toHaveBeenCalledOnce();
	});
});

function deferred<T>() {
	return Promise.withResolvers<T>();
}
