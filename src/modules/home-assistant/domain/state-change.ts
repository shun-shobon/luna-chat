import type { LunaEvent } from "../../event/domain/luna-event";
import { matchesAnyEntityPattern } from "./entity-pattern";
import { HOME_ASSISTANT_EVENT_SOURCE, STATE_CHANGED_EVENT_TYPE } from "./home-assistant-event";

export type HomeAssistantState = Readonly<{
	entityId: string;
	state: string;
	attributes: Readonly<Record<string, unknown>>;
	lastChanged: string;
	lastUpdated: string;
}>;

export type StateChange = Readonly<{
	entityId: string;
	oldState: HomeAssistantState | null;
	newState: HomeAssistantState | null;
}>;

export type WatchConfig = Readonly<{
	watch: readonly string[];
	ignore: readonly string[];
	cooldownSeconds: number;
}>;

export type StateChangeTrigger = Readonly<{
	entityId: string;
	oldState: HomeAssistantState;
	newState: HomeAssistantState;
}>;

export function findStateChangeTrigger(
	input: Readonly<{
		change: StateChange;
		config: WatchConfig;
		lastTriggeredAt: Date | undefined;
		now: Date;
	}>,
): StateChangeTrigger | undefined {
	const { change, config } = input;
	if (change.oldState == null || change.newState == null) return undefined;
	if (change.oldState.state === change.newState.state) return undefined;
	if (!matchesAnyEntityPattern(config.watch, change.entityId)) return undefined;
	if (matchesAnyEntityPattern(config.ignore, change.entityId)) return undefined;
	if (
		input.lastTriggeredAt !== undefined &&
		input.now.getTime() - input.lastTriggeredAt.getTime() < config.cooldownSeconds * 1000
	) {
		return undefined;
	}
	return { entityId: change.entityId, oldState: change.oldState, newState: change.newState };
}

export function createStateChangedEvent(trigger: StateChangeTrigger, id: string): LunaEvent {
	const attributes = trigger.newState.attributes;
	return {
		id,
		type: STATE_CHANGED_EVENT_TYPE,
		source: HOME_ASSISTANT_EVENT_SOURCE,
		subject: trigger.entityId,
		occurredAt: trigger.newState.lastChanged,
		data: {
			entity_id: trigger.entityId,
			friendly_name: stringAttribute(attributes, "friendly_name"),
			old_state: trigger.oldState.state,
			new_state: trigger.newState.state,
			unit: stringAttribute(attributes, "unit_of_measurement"),
			device_class: stringAttribute(attributes, "device_class"),
		},
	};
}

function stringAttribute(
	attributes: Readonly<Record<string, unknown>>,
	name: string,
): string | null {
	const value = attributes[name];
	return typeof value === "string" ? value : null;
}
