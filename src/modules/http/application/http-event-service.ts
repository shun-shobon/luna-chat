import type { AcceptedConversationEvent } from "../../conversation/domain/conversation-session";
import type { EventExecutionPort } from "../../event/ports/event-execution-port";
import {
  createHttpConversationSession,
  createHttpEvent,
  type HttpEventRequest,
} from "../domain/http-event";

import type { HttpResponseRegistry } from "./http-response-registry";
import { type HttpEventOutcome } from "./http-response-registry";

type ConversationIntake = Readonly<{ accept(input: AcceptedConversationEvent): boolean }>;

export type HttpSubmission =
  | Readonly<{ kind: "accepted"; requestId: string }>
  | Readonly<{ kind: "completed"; requestId: string; outcome: HttpEventOutcome }>
  | Readonly<{ kind: "unavailable" }>;

export class HttpEventService {
  readonly #executions = new Set<Promise<void>>();
  #accepting = true;

  constructor(
    private readonly dependencies: Readonly<{
      conversation: ConversationIntake;
      executor: EventExecutionPort;
      responses: HttpResponseRegistry;
    }>,
  ) {}

  async submit(request: HttpEventRequest): Promise<HttpSubmission> {
    if (!this.#accepting) return { kind: "unavailable" };
    const event = createHttpEvent(request);
    const response =
      request.response_mode === "wait" ? this.dependencies.responses.register(event.id) : undefined;

    try {
      if (request.execution === "conversation") {
        const accepted = this.dependencies.conversation.accept({
          session: createHttpConversationSession(request.session_id),
          event,
        });
        if (!accepted) {
          this.dependencies.responses.complete(event.id, false);
          return { kind: "unavailable" };
        }
      } else {
        const execution = this.dependencies.executor.execute(event).then(
          (result) => this.dependencies.responses.complete(event.id, result.status === "completed"),
          () => this.dependencies.responses.complete(event.id, false),
        );
        this.#executions.add(execution);
        void execution.then(() => this.#executions.delete(execution));
      }
    } catch (error: unknown) {
      this.dependencies.responses.complete(event.id, false);
      throw error;
    }

    if (response === undefined) return { kind: "accepted", requestId: event.id };
    return { kind: "completed", requestId: event.id, outcome: await response };
  }

  stopIntake(): void {
    this.#accepting = false;
  }

  async drain(): Promise<void> {
    while (this.#executions.size > 0) await Promise.all(this.#executions);
  }

  failPending(): void {
    this.dependencies.responses.failAll();
  }
}
