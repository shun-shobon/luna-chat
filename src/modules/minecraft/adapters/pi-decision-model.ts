import { createModels } from "@earendil-works/pi-ai";
import type { ClassifierApi, ClassifierModel, FetchFunction, Models } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { z } from "zod";

import type { GoalStatus } from "../domain/goal";
import type { Decision, DecisionInput, DecisionModelPort } from "../ports/decision-model-port";

const ACTION_QUESTION = "action";
const GOAL_QUESTION = "goal";
const GoalStatusSchema = z.enum(["done", "in_progress", "stuck"]);

const ACTION_INSTRUCTIONS =
	"The state is Luna's view of Minecraft: what she can see from her eyes and what she remembers, with her current goal from her planner. Choose the one action that best advances goal.objective right now. Prefer gathering what goal.targets asks for, avoid repeating actions that just failed in recent_actions, and keep her alive.";
const GOAL_INSTRUCTIONS =
	"Judge how goal.objective stands in the state. Count only what the state shows, such as the inventory, her position, and recent_actions.";
const GOAL_CRITERIA: Readonly<Record<GoalStatus, string>> = {
	done: "The objective is already achieved in the state.",
	in_progress:
		"The objective is not achieved yet, and the available actions can still move it forward.",
	stuck:
		"The objective cannot be advanced from here: recent actions keep failing, or nothing in reach helps.",
};

// 1手の判断は pi-ai の classify に任せ、提供元（OpenAI の Decisions API、TypeSafe の Jev）は設定で選ぶ。
export class PiDecisionModel implements DecisionModelPort {
	private constructor(
		private readonly models: Models,
		private readonly model: ClassifierModel<ClassifierApi>,
		private readonly options: Readonly<{ timeoutMs: number; fetch: FetchFunction }>,
	) {}

	// 鍵がないなどで使えないモデルは、プレイのたびに失敗させず起動時に断る。
	static async create(
		input: Readonly<{ provider: string; model: string; timeoutMs: number; fetch: FetchFunction }>,
	): Promise<PiDecisionModel> {
		const models = createModels();
		models.setProvider(openaiProvider());
		models.setProvider(typesafeProvider());
		const model = models.getModelOfType("classifier", input.provider, input.model);
		if (model === undefined) {
			throw new Error(`Unknown decision model: ${input.provider}/${input.model}`);
		}
		if ((await models.checkAuth(input.provider)) === undefined) {
			throw new Error(`No API key for decision model provider: ${input.provider}`);
		}
		return new PiDecisionModel(models, model, {
			timeoutMs: input.timeoutMs,
			fetch: input.fetch,
		});
	}

	async decide(input: DecisionInput, signal: AbortSignal): Promise<Decision> {
		const keys = input.candidates.map((_candidate, index) => `a${String(index)}`);
		const criteria: Record<string, string> = {};
		input.candidates.forEach((description, index) => {
			criteria[`a${String(index)}`] = description;
		});
		const result = await this.models.classify(
			this.model,
			{
				state: input.state,
				questions: {
					[ACTION_QUESTION]: {
						type: "choice",
						instructions: ACTION_INSTRUCTIONS,
						criteria,
					},
					[GOAL_QUESTION]: {
						type: "choice",
						instructions: GOAL_INSTRUCTIONS,
						criteria: GOAL_CRITERIA,
					},
				},
			},
			{
				signal,
				timeoutMs: this.options.timeoutMs,
				// 待つ間もゲームは進むため、やり直して遅れるより失敗として扱う。
				maxRetries: 0,
				fetch: this.options.fetch,
			},
		);
		if (result.stopReason !== "stop") {
			throw new Error(result.errorMessage ?? `decision ${result.stopReason}`);
		}
		const action = result.answers[ACTION_QUESTION];
		const goal = result.answers[GOAL_QUESTION];
		if (action?.type !== "choice" || goal?.type !== "choice") {
			throw new Error("decision returned no choice");
		}
		const choice = keys.indexOf(action.choice);
		if (choice < 0) throw new Error(`decision chose an unknown candidate: ${action.choice}`);
		const status = GoalStatusSchema.parse(goal.choice);
		const probability = goal.probabilities[status];
		if (probability === undefined) throw new Error(`decision has no probability for ${status}`);
		return { choice, goal: { status, probability } };
	}
}
