import { z } from "zod";

import type { AgentInputMessage } from "../../agent/ports/outbound/agent-session-port";
import type { LunaEvent } from "../../event/domain/luna-event";
import type { LoggerPort } from "../../observability/ports/logger-port";
import { findFiringIntents } from "../domain/standing-intent";
import type { IntentStorePort } from "../ports/intent-store-port";

// 人の発言だけを照合する。ルナ自身やbotの投稿で発火すると、自分の発言で予定を消費してしまう。
const humanMessageSchema = z.looseObject({
	data: z.looseObject({
		message: z.looseObject({
			id: z.string(),
			content: z.string(),
			author: z.looseObject({ kind: z.literal("human") }),
		}),
	}),
});

export class IntentMatcher {
	constructor(
		private readonly store: IntentStorePort,
		private readonly logger: LoggerPort,
		private readonly now: () => Date,
	) {}

	match(events: readonly LunaEvent[]): readonly AgentInputMessage[] {
		const messages = events.flatMap((event) => {
			const parsed = humanMessageSchema.safeParse(event);
			return parsed.success ? [parsed.data.data.message] : [];
		});
		if (messages.length === 0) return [];
		let intents;
		let states;
		try {
			intents = this.store.readIntents();
			states = { ...this.store.readStates() };
		} catch (error: unknown) {
			this.logger.error("intent.read_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}

		const inputs: AgentInputMessage[] = [];
		const now = this.now();
		for (const message of messages) {
			for (const { intent, keyword } of findFiringIntents({
				intents,
				states,
				text: message.content,
				now,
			})) {
				const fires = (states[intent.id]?.fires ?? 0) + 1;
				states[intent.id] = { fires, lastFiredAt: now.toISOString() };
				inputs.push({
					kind: "intent",
					text: JSON.stringify({
						id: intent.id,
						action: intent.action,
						keyword,
						messageId: message.id,
						firesRemaining: intent.maxFires - fires,
					}),
				});
				this.logger.info("intent.fired", { intentId: intent.id, keyword });
			}
		}
		if (inputs.length > 0) {
			try {
				this.store.writeStates(states);
			} catch (error: unknown) {
				this.logger.error("intent.state_write_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return inputs;
	}
}
