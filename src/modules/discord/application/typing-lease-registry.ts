type TypingLeaseErrorHandler = (error: unknown, context: TypingLeaseContext) => void;

type TypingLeaseContext = Readonly<{
  ownerId: string;
  channelId: string;
}>;

type TypingLease = TypingLeaseContext &
  Readonly<{
    timer: ReturnType<typeof setInterval>;
  }>;

export class TypingLeaseRegistry {
  readonly #leases = new Map<string, TypingLease>();
  readonly #pendingStarts = new Map<string, Promise<void>>();
  readonly #startTokens = new Map<string, symbol>();

  constructor(
    private readonly refreshIntervalMs: number,
    private readonly onError: TypingLeaseErrorHandler,
  ) {
    if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs <= 0) {
      throw new Error("Typing refresh interval must be a positive safe integer");
    }
  }

  async start(context: TypingLeaseContext, refresh: () => Promise<void>): Promise<void> {
    const key = leaseKey(context);
    if (this.#leases.has(key)) return;
    const pending = this.#pendingStarts.get(key);
    if (pending !== undefined) return await pending;

    const startToken = Symbol(key);
    this.#startTokens.set(key, startToken);
    const starting = (async () => {
      await refresh();
      if (this.#startTokens.get(key) !== startToken) return;
      const timer = setInterval(() => {
        void refresh().catch((error: unknown) => {
          this.onError(error, context);
        });
      }, this.refreshIntervalMs);
      this.#leases.set(key, { ...context, timer });
    })();
    this.#pendingStarts.set(key, starting);
    try {
      await starting;
    } finally {
      if (this.#pendingStarts.get(key) === starting) {
        this.#pendingStarts.delete(key);
        this.#startTokens.delete(key);
      }
    }
  }

  stop(context: TypingLeaseContext): void {
    const key = leaseKey(context);
    this.#startTokens.delete(key);
    const lease = this.#leases.get(key);
    if (lease === undefined) return;
    clearInterval(lease.timer);
    this.#leases.delete(key);
  }

  releaseOwner(ownerId: string): void {
    for (const key of this.#pendingStarts.keys()) {
      if (key.startsWith(`${ownerId}:`)) this.#startTokens.delete(key);
    }
    for (const lease of this.#leases.values()) {
      if (lease.ownerId === ownerId) this.stop(lease);
    }
  }

  releaseAll(): void {
    this.#startTokens.clear();
    for (const lease of this.#leases.values()) this.stop(lease);
  }

  get size(): number {
    return this.#leases.size;
  }
}

function leaseKey(context: TypingLeaseContext): string {
  return `${context.ownerId}:${context.channelId}`;
}
