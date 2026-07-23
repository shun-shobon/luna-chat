import chokidar, { type FSWatcher } from "chokidar";

import type { AutomationScheduleWatcherPort } from "../ports/automation-schedule-port";

export class ChokidarScheduleWatcher implements AutomationScheduleWatcherPort {
  readonly #schedulePath: string;
  #watcher: FSWatcher | undefined;

  constructor(schedulePath: string) {
    this.#schedulePath = schedulePath;
  }

  async start(input: { onChange: () => void; onError: (error: unknown) => void }): Promise<void> {
    if (this.#watcher !== undefined) {
      return;
    }

    const watcher = chokidar.watch(this.#schedulePath, { ignoreInitial: true });
    watcher.on("add", input.onChange);
    watcher.on("change", input.onChange);
    watcher.on("unlink", input.onChange);
    this.#watcher = watcher;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      watcher.once("ready", () => {
        ready = true;
        input.onChange();
        resolve();
      });
      watcher.on("error", (error) => {
        if (ready) input.onError(error);
        else reject(error);
      });
    });
  }

  async close(): Promise<void> {
    const watcher = this.#watcher;
    this.#watcher = undefined;
    await watcher?.close();
  }
}
