export type AssistOutcome =
	| Readonly<{ kind: "response"; speech: string | null; continueConversation: boolean }>
	| Readonly<{ kind: "failed" }>;

export class AssistResponseRegistry {
	readonly #pending = new Map<string, (outcome: AssistOutcome) => void>();

	register(requestId: string): Promise<AssistOutcome> {
		return new Promise<AssistOutcome>((resolve) => {
			this.#pending.set(requestId, resolve);
		});
	}

	respond(requestId: string, speech: string, continueConversation: boolean): void {
		const resolve = this.#pending.get(requestId);
		if (resolve === undefined) {
			throw new Error(`Assist request is not waiting for a response: ${requestId}.`);
		}
		this.#pending.delete(requestId);
		resolve({ kind: "response", speech, continueConversation });
	}

	complete(requestId: string, succeeded: boolean): void {
		const resolve = this.#pending.get(requestId);
		if (resolve === undefined) return;
		this.#pending.delete(requestId);
		resolve(
			succeeded
				? { kind: "response", speech: null, continueConversation: false }
				: { kind: "failed" },
		);
	}

	failAll(): void {
		for (const requestId of this.#pending.keys()) this.complete(requestId, false);
	}
}
