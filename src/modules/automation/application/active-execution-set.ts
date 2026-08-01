export class ActiveExecutionSet {
  readonly #active = new Set<Promise<void>>();

  track(execution: Promise<void>): void {
    this.#active.add(execution);
    void execution.then(
      () => {
        this.#active.delete(execution);
      },
      () => {
        this.#active.delete(execution);
      },
    );
  }

  async drain(): Promise<void> {
    while (this.#active.size > 0) {
      await Promise.allSettled(this.#active);
    }
  }
}
