import type {
  AgentRuntimePort,
  AgentTurnResult,
} from "../../agent/ports/outbound/agent-runtime-port";
import type { ConversationThreadInput } from "../../conversation/application/conversation-coordinator";
import type { DiscordActionBatchPort } from "../../discord/ports/discord-action-batch-port";
import type { AutomationInput } from "../domain/automation-input";
import type { AutomationAgentPort, StartedAutomationTurn } from "../ports/automation-agent-port";

export class AutomationAgentAdapter implements AutomationAgentPort {
  readonly #owners = new Map<string, string>();
  #connectionGeneration = 0;

  constructor(
    private readonly agent: AgentRuntimePort,
    private readonly actions: DiscordActionBatchPort,
    private readonly createThreadInput: () => Promise<ConversationThreadInput>,
    private readonly onError: (error: unknown, operation: string) => void,
  ) {}

  async archiveThread(threadId: string): Promise<void> {
    const ownerId = this.#owners.get(threadId);
    if (ownerId === undefined) return;
    this.#owners.delete(threadId);
    await this.#releaseTyping(ownerId);
    await this.agent.archiveThread(threadId);
  }

  connectionLost(): void {
    this.#connectionGeneration += 1;
    for (const ownerId of this.#owners.values()) void this.#releaseTyping(ownerId);
    this.#owners.clear();
  }

  async deleteArchivedThread(threadId: string): Promise<void> {
    await this.agent.deleteThread(threadId);
  }

  async listArchivedThreads(input: {
    cursor?: string;
  }): ReturnType<AutomationAgentPort["listArchivedThreads"]> {
    const page = await this.agent.listThreads({ archived: true, cursor: input.cursor });
    return {
      data: page.data.map((thread) => ({ id: thread.id, updatedAt: thread.updatedAt })),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  async openAutomationThread(): Promise<string> {
    const connectionGeneration = this.#connectionGeneration;
    const input = await this.createThreadInput();
    if (connectionGeneration !== this.#connectionGeneration) {
      throw new Error("Codex connection was lost while preparing an automation thread");
    }
    const threadId = await this.agent.openThread(input);
    if (connectionGeneration !== this.#connectionGeneration) {
      throw new Error("Codex connection was lost while opening an automation thread");
    }
    this.#owners.set(threadId, input.actionOwnerId);
    return threadId;
  }

  async startAutomationTurn(
    threadId: string,
    input: AutomationInput,
  ): Promise<StartedAutomationTurn> {
    const ownerId = this.#owners.get(threadId);
    if (ownerId === undefined) throw new Error(`Automation thread is not owned: ${threadId}`);
    const started = await this.agent.startTurn(threadId, JSON.stringify(input));
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
          throw new Error(turn.errorMessage ?? `Automation turn ${turn.status}`);
        }
        const results = await this.actions.execute(turn.output.actions, ownerId);
        await this.#releaseTyping(ownerId);
        if (connectionGeneration !== this.#connectionGeneration) {
          throw new Error("Codex connection was lost while Discord actions were running");
        }
        if (results.every((result) => result.success)) return;
        const followUp = await this.agent.startTurn(
          threadId,
          JSON.stringify({ source: "discord_action_results", results }),
        );
        completion = followUp.completion;
      } catch (error: unknown) {
        await this.#releaseTyping(ownerId);
        throw error;
      }
    }
  }

  async #releaseTyping(ownerId: string): Promise<void> {
    try {
      await this.actions.releaseTyping(ownerId);
    } catch (error: unknown) {
      this.onError(error, "typing/release");
    }
  }
}
