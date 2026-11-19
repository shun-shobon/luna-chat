import type { LoggerPort } from "../../observability/ports/logger-port";
import type { AsideKind } from "../domain/voice-record";
import type { InterruptClassifierPort } from "../ports/interrupt-classifier-port";
import type { TranscriberPort } from "../ports/transcriber-port";

// 読み上げ中に聞こえた1回分の声をどう扱うか。
export type Hearing =
	| Readonly<{ kind: "noise" }>
	| Readonly<{ kind: "aside"; aside: AsideKind; text: string }>
	| Readonly<{ kind: "interruption" }>;

type InterruptJudgeDependencies = Readonly<{
	transcriber: TranscriberPort;
	classifier: InterruptClassifierPort;
	ongoingSpeech(userId: string): Float32Array | undefined;
	logger: LoggerPort;
	now(): number;
	// 声が区切れる前に一度判定するまでの時間。長く話し続ける割り込みを待たずに止めるため。
	earlyCheckMs: number;
}>;

type JudgeHandlers = Readonly<{
	// 割り込みと決まった。1回の声につき1度だけ呼ぶ。
	onInterruption(userId: string): void;
}>;

type Open = {
	readonly lunaSaying: string;
	readonly startedAt: number;
	readonly controller: AbortController;
	readonly timer: ReturnType<typeof setTimeout>;
	interrupted: boolean;
};

// 再生中に聞こえた声を話者ごとに追い、相づちや雑音では止まらず、割り込みのときだけ止める。
export class InterruptJudge {
	readonly #open = new Map<string, Open>();

	constructor(
		private readonly dependencies: InterruptJudgeDependencies,
		private readonly handlers: JudgeHandlers,
	) {}

	get judging(): boolean {
		return this.#open.size > 0;
	}

	isJudging(userId: string): boolean {
		return this.#open.has(userId);
	}

	start(userId: string, lunaSaying: string): void {
		if (this.#open.has(userId)) return;
		const open: Open = {
			lunaSaying,
			startedAt: this.dependencies.now(),
			controller: new AbortController(),
			timer: setTimeout(() => {
				const samples = this.dependencies.ongoingSpeech(userId);
				if (samples !== undefined) void this.#check(userId, open, samples, "early");
			}, this.dependencies.earlyCheckMs),
			interrupted: false,
		};
		this.#open.set(userId, open);
	}

	// 声が区切れた。この声の扱いを決めて返す。
	async end(userId: string, samples: Float32Array): Promise<Hearing> {
		const open = this.#open.get(userId);
		if (open === undefined) return { kind: "noise" };
		clearTimeout(open.timer);
		try {
			if (open.interrupted) return { kind: "interruption" };
			const hearing = await this.#check(userId, open, samples, "final");
			return isSettled(open) ? { kind: "interruption" } : hearing;
		} finally {
			// 区切れる前の判定がまだ返っていなければ、決まった扱いを後から覆させない。
			open.controller.abort();
			if (this.#open.get(userId) === open) this.#open.delete(userId);
		}
	}

	cancelAll(): void {
		for (const open of this.#open.values()) {
			clearTimeout(open.timer);
			open.controller.abort();
		}
		this.#open.clear();
	}

	async #check(
		userId: string,
		open: Open,
		samples: Float32Array,
		stage: "early" | "final",
	): Promise<Hearing> {
		const logger = this.dependencies.logger;
		let transcription;
		try {
			transcription = await this.dependencies.transcriber.transcribe(samples);
		} catch (error: unknown) {
			logger.error("voice.interrupt.transcription_failed", { userId, stage, error });
			return this.#interrupt(userId, open);
		}
		if (open.interrupted || open.controller.signal.aborted) return { kind: "interruption" };
		if (transcription.text === "" || transcription.nonVerbal) {
			logger.info("voice.interrupt.judged", { userId, stage, verdict: "noise" });
			return { kind: "noise" };
		}
		const classifiedAt = this.dependencies.now();
		let verdict: "interruption" | AsideKind;
		try {
			verdict = await this.dependencies.classifier.classify(
				{ heard: transcription.text, lunaSaying: open.lunaSaying },
				open.controller.signal,
			);
		} catch (error: unknown) {
			if (isAborted(open)) return { kind: "interruption" };
			logger.error("voice.interrupt.classification_failed", { userId, stage, error });
			verdict = "interruption";
		}
		logger.info("voice.interrupt.judged", {
			userId,
			stage,
			verdict,
			sttMs: transcription.elapsedMs,
			classifyMs: Math.round(this.dependencies.now() - classifiedAt),
			sinceOverlapMs: Math.round(this.dependencies.now() - open.startedAt),
		});
		if (verdict !== "interruption")
			return { kind: "aside", aside: verdict, text: transcription.text };
		return this.#interrupt(userId, open);
	}

	// 判定できない時も、聞き逃すより止まって聞く方を選ぶ。
	#interrupt(userId: string, open: Open): Hearing {
		if (!open.interrupted && !open.controller.signal.aborted) {
			open.interrupted = true;
			this.handlers.onInterruption(userId);
		}
		return { kind: "interruption" };
	}
}

// 以下は await の間に別の判定や cancelAll で変わるため、読むたびに確かめる。
function isSettled(open: Open): boolean {
	return open.interrupted;
}

function isAborted(open: Open): boolean {
	return open.controller.signal.aborted;
}
