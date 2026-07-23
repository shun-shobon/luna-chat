import chokidar, { type FSWatcher } from "chokidar";

import type { AutomationScheduleWatcherPort } from "../ports/automation-schedule-port";

export class ChokidarScheduleWatcher implements AutomationScheduleWatcherPort {
  readonly #schedulePath: string;
  #readyPromise: Promise<void> | undefined;
  #rejectReady: ((error: Error) => void) | undefined;
  #watcher: FSWatcher | undefined;

  constructor(schedulePath: string) {
    this.#schedulePath = schedulePath;
  }

  async start(input: { onChange: () => void; onError: (error: unknown) => void }): Promise<void> {
    if (this.#watcher !== undefined) {
      await this.#readyPromise;
      return;
    }

    const watcher = chokidar.watch(this.#schedulePath, { ignoreInitial: true });
    watcher.on("add", input.onChange);
    watcher.on("change", input.onChange);
    watcher.on("unlink", input.onChange);
    this.#watcher = watcher;
    const readyPromise = new Promise<void>((resolve, reject) => {
      this.#rejectReady = reject;
      let ready = false;
      watcher.once("ready", () => {
        ready = true;
        this.#rejectReady = undefined;
        input.onChange();
        resolve();
      });
      watcher.on("error", (error) => {
        if (ready) input.onError(error);
        else reject(error);
      });
    });
    this.#readyPromise = readyPromise;
    try {
      await readyPromise;
    } finally {
      if (this.#readyPromise === readyPromise) this.#readyPromise = undefined;
      this.#rejectReady = undefined;
    }
  }

  async close(): Promise<void> {
    const watcher = this.#watcher;
    this.#watcher = undefined;
    this.#rejectReady?.(new Error("Schedule watcher closed before becoming ready"));
    this.#rejectReady = undefined;
    await watcher?.close();
  }
}
