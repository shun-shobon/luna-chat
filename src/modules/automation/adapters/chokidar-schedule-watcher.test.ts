import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const listeners = new Map<string, Set<(value?: unknown) => void>>();
  const watcher = {
    close: vi.fn(async () => {
      listeners.clear();
    }),
    on: vi.fn((event: string, listener: (value?: unknown) => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return watcher;
    }),
    once: vi.fn((event: string, listener: (value?: unknown) => void) => {
      const onceListener = (value?: unknown) => {
        listeners.get(event)?.delete(onceListener);
        listener(value);
      };
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(onceListener);
      listeners.set(event, eventListeners);
      return watcher;
    }),
  };
  return { watcher };
});

vi.mock("chokidar", () => ({ default: { watch: vi.fn(() => fake.watcher) } }));

import { ChokidarScheduleWatcher } from "./chokidar-schedule-watcher";

describe("ChokidarScheduleWatcher", () => {
  it("ready待機中のcloseでstartを失敗させる", async () => {
    const watcher = new ChokidarScheduleWatcher("/tmp/cron.toml");
    const starting = watcher.start({ onChange: vi.fn(), onError: vi.fn() });

    await watcher.close();

    await expect(starting).rejects.toThrow("closed before becoming ready");
    expect(fake.watcher.close).toHaveBeenCalledOnce();
  });
});
