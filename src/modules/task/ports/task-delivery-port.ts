import type { LunaEvent } from "../../event/domain/luna-event";
import type { TaskOrigin } from "../domain/task";

export type TaskDeliveryOutcome = "accepted" | "rejected";

export interface TaskDeliveryPort {
	deliver(origin: TaskOrigin, event: LunaEvent): Promise<TaskDeliveryOutcome>;
}
