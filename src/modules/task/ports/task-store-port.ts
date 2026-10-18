import type { Task } from "../domain/task";

export interface TaskStorePort {
	loadAll(): Promise<readonly Task[]>;
	save(task: Task): Promise<void>;
}
