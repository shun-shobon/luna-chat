import type { JsonObject } from "../../../shared/json";

export interface EventTaskBoardPort {
	listAll(): readonly JsonObject[];
}
