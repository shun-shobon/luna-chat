import type { AcceptedConversationEvent } from "../../conversation/domain/conversation-session";
import { createAssistRequestedEvent, createAssistSession } from "../domain/assist-request";
import type { AssistRequest } from "../domain/assist-request";
import type { AssistOutcome, AssistResponseRegistry } from "./assist-response-registry";

export type AssistSubmission = AssistOutcome | Readonly<{ kind: "unavailable" }>;

export class AssistService {
	#accepting = true;

	constructor(
		private readonly dependencies: Readonly<{
			conversation: Readonly<{ accept(input: AcceptedConversationEvent): boolean }>;
			createId: () => string;
			now: () => Date;
			responses: AssistResponseRegistry;
		}>,
	) {}

	async submit(request: AssistRequest): Promise<AssistSubmission> {
		if (!this.#accepting) return { kind: "unavailable" };
		const event = createAssistRequestedEvent(
			request,
			this.dependencies.createId(),
			this.dependencies.now(),
		);
		const outcome = this.dependencies.responses.register(event.id);
		const accepted = this.dependencies.conversation.accept({
			session: createAssistSession(request),
			event,
		});
		if (!accepted) {
			this.dependencies.responses.complete(event.id, false);
			return { kind: "unavailable" };
		}
		return await outcome;
	}

	stopIntake(): void {
		this.#accepting = false;
	}
}
