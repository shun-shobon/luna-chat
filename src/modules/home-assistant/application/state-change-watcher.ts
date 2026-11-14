import type { AcceptedConversationEvent } from "../../conversation/domain/conversation-session";
import type { LoggerPort } from "../../observability/ports/logger-port";
import { STATE_CHANGES_SESSION } from "../domain/home-assistant-event";
import type {
	HomeAssistantConnectionStatus,
	HomeAssistantStatus,
} from "../domain/home-assistant-status";
import { createStateChangedEvent, findStateChangeTrigger } from "../domain/state-change";
import type { StateChange } from "../domain/state-change";
import type { WatchConfigPort } from "../ports/watch-config-port";

export class StateChangeWatcher {
	readonly #lastTriggeredAtByEntity = new Map<string, Date>();
	#accepting = true;
	#triggeredCount = 0;
	#latestTriggerAt: Date | undefined;

	constructor(
		private readonly dependencies: Readonly<{
			config: WatchConfigPort;
			conversation: Readonly<{ accept(input: AcceptedConversationEvent): boolean }>;
			connectionStatus: () => HomeAssistantConnectionStatus;
			createId: () => string;
			logger: LoggerPort;
			now: () => Date;
		}>,
	) {}

	handle(change: StateChange): void {
		if (!this.#accepting) return;
		const config = this.dependencies.config.read();
		if (config.status !== "valid") return;
		const now = this.dependencies.now();
		const trigger = findStateChangeTrigger({
			change,
			config: config.config,
			lastTriggeredAt: this.#lastTriggeredAtByEntity.get(change.entityId),
			now,
		});
		if (trigger === undefined) return;

		const event = createStateChangedEvent(trigger, this.dependencies.createId());
		if (!this.dependencies.conversation.accept({ session: STATE_CHANGES_SESSION, event })) return;
		this.#lastTriggeredAtByEntity.set(change.entityId, now);
		this.#triggeredCount += 1;
		this.#latestTriggerAt = now;
		this.dependencies.logger.info(
			"home_assistant.state_change_triggered",
			{ entityId: trigger.entityId, eventId: event.id },
			event.data,
		);
	}

	stopIntake(): void {
		this.#accepting = false;
	}

	status(): HomeAssistantStatus {
		return {
			connection: this.dependencies.connectionStatus(),
			watchConfig: this.dependencies.config.read(),
			triggered: {
				count: this.#triggeredCount,
				lastAt: this.#latestTriggerAt?.toISOString() ?? null,
			},
		};
	}
}
