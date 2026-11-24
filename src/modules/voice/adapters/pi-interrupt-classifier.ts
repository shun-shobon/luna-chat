import { createModels } from "@earendil-works/pi-ai";
import type { ClassifierApi, ClassifierModel, FetchFunction, Models } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { z } from "zod";

import type {
	InterruptClassifierPort,
	InterruptQuestion,
	InterruptVerdict,
} from "../ports/interrupt-classifier-port";

const QUESTION = "turn";
const VerdictSchema = z.enum(["interruption", "backchannel", "not_to_luna"]);

const INSTRUCTIONS =
	"An AI is speaking aloud in a voice chat. While it was saying luna_is_saying, a person said heard (a speech-to-text transcript that can contain recognition errors, usually Japanese). Decide whether the AI should stop talking and listen to them now.";

const CRITERIA: Readonly<Record<InterruptVerdict, string>> = {
	interruption:
		"They want the AI to stop and listen: they ask or tell it something, correct it, disagree, change the subject, or answer a question it asked with more than a short acknowledgement.",
	backchannel:
		"A short listener response that shows they follow and want it to go on, such as うん, へえ, なるほど, そうなんだ, or laughing.",
	not_to_luna:
		"Speech not meant for the AI: talking to someone else in the call, to themselves, or to someone off the call.",
};

// 判定は pi-ai の classify に任せ、提供元（OpenAI の Decisions API、TypeSafe の Jev）は設定で選ぶ。
export class PiInterruptClassifier implements InterruptClassifierPort {
	private constructor(
		private readonly models: Models,
		private readonly model: ClassifierModel<ClassifierApi>,
		private readonly options: Readonly<{ timeoutMs: number; fetch: FetchFunction }>,
	) {}

	// 鍵がないなどで使えないモデルは、読み上げのたびに失敗させず起動時に断る。
	static async create(
		input: Readonly<{ provider: string; model: string; timeoutMs: number; fetch: FetchFunction }>,
	): Promise<PiInterruptClassifier> {
		const models = createModels();
		models.setProvider(openaiProvider());
		models.setProvider(typesafeProvider());
		const model = models.getModelOfType("classifier", input.provider, input.model);
		if (model === undefined) {
			throw new Error(`Unknown classifier model: ${input.provider}/${input.model}`);
		}
		if ((await models.checkAuth(input.provider)) === undefined) {
			throw new Error(`No API key for classifier provider: ${input.provider}`);
		}
		return new PiInterruptClassifier(models, model, {
			timeoutMs: input.timeoutMs,
			fetch: input.fetch,
		});
	}

	async classify(question: InterruptQuestion, signal: AbortSignal): Promise<InterruptVerdict> {
		const result = await this.models.classify(
			this.model,
			{
				state: { luna_is_saying: question.lunaSaying, heard: question.heard },
				questions: {
					[QUESTION]: { type: "choice", instructions: INSTRUCTIONS, criteria: CRITERIA },
				},
			},
			{
				signal,
				timeoutMs: this.options.timeoutMs,
				// 判定を待つ間もエージェントは話し続けるので、やり直して遅れるより失敗として扱う。
				maxRetries: 0,
				fetch: this.options.fetch,
			},
		);
		if (result.stopReason !== "stop") {
			throw new Error(result.errorMessage ?? `interrupt classification ${result.stopReason}`);
		}
		const answer = result.answers[QUESTION];
		if (answer?.type !== "choice") {
			throw new Error("interrupt classification returned no choice");
		}
		return VerdictSchema.parse(answer.choice);
	}
}
