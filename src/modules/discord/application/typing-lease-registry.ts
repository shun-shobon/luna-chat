type TypingLeaseErrorHandler = (error: unknown, context: TypingLeaseContext) => void;

type TypingLeaseContext = Readonly<{
	ownerId: string;
	channelId: string;
}>;

type TypingLease = TypingLeaseContext & {
	readonly started: Promise<void>;
	timer?: ReturnType<typeof setInterval>;
};

export class TypingLeaseRegistry {
	readonly #leases = new Map<string, TypingLease>();

	constructor(
		private readonly refreshIntervalMs: number,
		private readonly onError: TypingLeaseErrorHandler,
	) {}

	async start(context: TypingLeaseContext, refresh: () => Promise<void>): Promise<void> {
		const key = leaseKey(context);
		const existing = this.#leases.get(key);
		if (existing !== undefined) {
			await existing.started;
			return;
		}

		const lease: TypingLease = { ...context, started: refresh() };
		this.#leases.set(key, lease);
		try {
			await lease.started;
		} catch (error: unknown) {
			if (this.#leases.get(key) === lease) this.#leases.delete(key);
			throw error;
		}
		// 初回送信中にstop・releaseされたleaseへintervalを張らない。
		if (this.#leases.get(key) !== lease) return;
		lease.timer = setInterval(() => {
			void refresh().catch((error: unknown) => {
				this.onError(error, context);
			});
		}, this.refreshIntervalMs);
	}

	stop(context: TypingLeaseContext): void {
		const key = leaseKey(context);
		const lease = this.#leases.get(key);
		if (lease === undefined) return;
		clearInterval(lease.timer);
		this.#leases.delete(key);
	}

	releaseOwner(ownerId: string): void {
		for (const lease of this.#leases.values()) {
			if (lease.ownerId === ownerId) this.stop(lease);
		}
	}

	releaseAll(): void {
		for (const lease of this.#leases.values()) this.stop(lease);
	}
}

function leaseKey(context: TypingLeaseContext): string {
	return `${context.ownerId}:${context.channelId}`;
}
