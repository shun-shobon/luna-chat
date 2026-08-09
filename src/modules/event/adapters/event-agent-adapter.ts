import type {
  AgentRuntimePort,
  AgentThreadInput,
  AgentTurnResult,
} from "../../agent/ports/outbound/agent-runtime-port";
import type { EffectBatchPort } from "../../effect/ports/effect-batch-port";
import type { EffectOutputContract } from "../../effect/ports/effect-output-contract";
import type { LunaEvent } from "../domain/luna-event";
import type { EventAgentPort, StartedEventTurn } from "../ports/event-agent-port";

export class EventAgentAdapter implements EventAgentPort {
  readonly #owners = new Map<string, string>();
  #connectionGeneration = 0;

  public constructor(
    private readonly dependencies: Readonly<{
      agent: AgentRuntimePort;
      createThreadInput: () => Promise<AgentThreadInput>;
      effectOutput: EffectOutputContract;
      effects: EffectBatchPort;
      onError: (error: unknown, operation: string) => void;
    }>,
  ) {}

  public async archiveThread(threadId: string): Promise<void> {
    const ownerId = this.#owners.get(threadId);
    if (ownerId === undefined) return;
    this.#owners.delete(threadId);
    await this.#releaseEffects(ownerId);
    await this.dependencies.agent.archiveThread(threadId);
  }

  public connectionLost(): void {
    this.#connectionGeneration += 1;
    for (const ownerId of this.#owners.values()) void this.#releaseEffects(ownerId);
    this.#owners.clear();
  }

  public async openEventThread(): Promise<string> {
    const connectionGeneration = this.#connectionGeneration;
    const input = await this.dependencies.createThreadInput();
    if (connectionGeneration !== this.#connectionGeneration) {
      throw new Error("Codex connection was lost while preparing an event thread");
    }
    const threadId = await this.dependencies.agent.openThread(input);
    if (connectionGeneration !== this.#connectionGeneration) {
      throw new Error("Codex connection was lost while opening an event thread");
    }
    this.#owners.set(threadId, input.executionOwnerId);
    return threadId;
  }

  public async startEventTurn(threadId: string, event: LunaEvent): Promise<StartedEventTurn> {
    const ownerId = this.#owners.get(threadId);
    if (ownerId === undefined) throw new Error(`Event thread is not owned: ${threadId}`);
    const started = await this.dependencies.agent.startTurn(threadId, {
      input: JSON.stringify({ source: "event", event }),
      outputSchema: this.dependencies.effectOutput.jsonSchema,
    });
    const connectionGeneration = this.#connectionGeneration;
    return {
      completion: this.#completeChain(threadId, ownerId, connectionGeneration, started.completion),
    };
  }

  async #completeChain(
    threadId: string,
    ownerId: string,
    connectionGeneration: number,
    initialCompletion: Promise<AgentTurnResult>,
  ): Promise<void> {
    let completion = initialCompletion;
    while (true) {
      try {
        const turn = await completion;
        if (turn.status !== "completed") {
          throw new Error(turn.errorMessage ?? `Event turn ${turn.status}`);
        }
        const output = this.dependencies.effectOutput.parse(turn.outputText);
        const results = await this.dependencies.effects.execute(output.effects, ownerId);
        await this.#releaseEffects(ownerId);
        if (connectionGeneration !== this.#connectionGeneration) {
          throw new Error("Codex connection was lost while effects were running");
        }
        if (results.every((result) => result.success)) return;
        const followUp = await this.dependencies.agent.startTurn(threadId, {
          input: JSON.stringify({ source: "effect_results", results }),
          outputSchema: this.dependencies.effectOutput.jsonSchema,
        });
        completion = followUp.completion;
      } catch (error: unknown) {
        await this.#releaseEffects(ownerId);
        throw error;
      }
    }
  }

  async #releaseEffects(ownerId: string): Promise<void> {
    try {
      await this.dependencies.effects.release(ownerId);
    } catch (error: unknown) {
      this.dependencies.onError(error, "effects/release");
    }
  }
}
