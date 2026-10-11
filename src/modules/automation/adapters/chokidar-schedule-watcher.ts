import { watch } from "chokidar";
import type { FSWatcher } from "chokidar";

import type { AutomationScheduleWatcherPort } from "../ports/automation-schedule-port";

export class ChokidarScheduleWatcher implements AutomationScheduleWatcherPort {
	readonly #schedulePath: string;
	#rejectReady: ((error: Error) => void) | undefined;
	#watcher: FSWatcher | undefined;

	constructor(schedulePath: string) {
		this.#schedulePath = schedulePath;
	}

	async start(input: { onChange: () => void; onError: (error: unknown) => void }): Promise<void> {
		const watcher = watch(this.#schedulePath, { ignoreInitial: true });
		watcher.on("add", input.onChange);
		watcher.on("change", input.onChange);
		watcher.on("unlink", input.onChange);
		this.#watcher = watcher;
		try {
			await new Promise<void>((resolve, reject) => {
				this.#rejectReady = reject;
				let ready = false;
				watcher.once("ready", () => {
					ready = true;
					input.onChange();
					resolve();
				});
				watcher.on("error", (error) => {
					if (ready) input.onError(error);
					else reject(error instanceof Error ? error : new Error(String(error)));
				});
			});
		} finally {
			this.#rejectReady = undefined;
		}
	}

	async close(): Promise<void> {
		const watcher = this.#watcher;
		this.#watcher = undefined;
		this.#rejectReady?.(new Error("Schedule watcher closed before becoming ready"));
		await watcher?.close();
	}
}
