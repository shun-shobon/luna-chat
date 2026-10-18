import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { taskSchema } from "../domain/task";
import type { Task } from "../domain/task";
import type { TaskStorePort } from "../ports/task-store-port";

const TASK_FILE_SUFFIX = ".json";

export class JsonFileTaskStore implements TaskStorePort {
	constructor(
		private readonly directory: string,
		private readonly onInvalidFile: (path: string, error: unknown) => void,
	) {}

	async loadAll(): Promise<readonly Task[]> {
		const names = (await readdir(this.directory)).filter((name) => name.endsWith(TASK_FILE_SUFFIX));
		const tasks: Task[] = [];
		for (const name of names.toSorted()) {
			const path = join(this.directory, name);
			try {
				tasks.push(taskSchema.parse(JSON.parse(await readFile(path, "utf8"))));
			} catch (error: unknown) {
				this.onInvalidFile(path, error);
			}
		}
		return tasks;
	}

	async save(task: Task): Promise<void> {
		const path = join(this.directory, `${task.id}${TASK_FILE_SUFFIX}`);
		const temporaryPath = `${path}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(task, null, "\t")}\n`, { mode: 0o600 });
		await rename(temporaryPath, path);
	}
}
