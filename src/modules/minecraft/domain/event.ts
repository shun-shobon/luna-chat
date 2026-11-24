import type { JsonObject } from "../../../shared/json";

export const MINECRAFT_EVENT_KIND = "minecraft_event";

export type MinecraftEventType =
	| "goal_done"
	| "goal_stuck"
	| "reflex"
	| "death"
	| "disconnected"
	| "interval";

const URGENT_TYPES: ReadonlySet<MinecraftEventType> = new Set(["reflex", "death", "disconnected"]);

// 計画役のセッションへ渡す出来事（docs/minecraft.md の「出来事」の MinecraftEvent）。
export type MinecraftEvent = Readonly<{
	type: MinecraftEventType;
	urgent: boolean;
	at: string;
	detail: string;
	observation: JsonObject | null;
}>;

export function createMinecraftEvent(
	input: Readonly<{
		type: MinecraftEventType;
		at: string;
		detail: string;
		observation: JsonObject | null;
	}>,
): MinecraftEvent {
	return { ...input, urgent: URGENT_TYPES.has(input.type) };
}

export function minecraftEventJson(event: MinecraftEvent): JsonObject {
	return {
		type: event.type,
		urgent: event.urgent,
		at: event.at,
		detail: event.detail,
		observation: event.observation,
	};
}
