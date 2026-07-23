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
    expect(registry.size).toBe(0);
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

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).not.toHaveBeenCalled();
    expect(registry.size).toBe(0);
  });

  it("pending start中のreleaseAllでinterval作成を中止する", async () => {
    const refreshing = deferred<void>();
    const registry = new TypingLeaseRegistry(1_000, vi.fn());
    const starting = registry.start(
      { ownerId: "turn-1", channelId: "100" },
      async () => await refreshing.promise,
    );

    registry.releaseAll();
    refreshing.resolve(undefined);
    await starting;

    expect(registry.size).toBe(0);
  });

  it("pending start中のstopで対象interval作成を中止する", async () => {
    const refreshing = deferred<void>();
    const registry = new TypingLeaseRegistry(1_000, vi.fn());
    const context = { ownerId: "turn-1", channelId: "100" };
    const starting = registry.start(context, async () => await refreshing.promise);

    registry.stop(context);
    refreshing.resolve(undefined);
    await starting;

    expect(registry.size).toBe(0);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("deferred is not initialized");
      resolvePromise(value);
    },
  };
}
