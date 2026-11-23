import { SerialQueue } from "../../../shared/serial-queue";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type { SpeechSynthesizerPort, VoicePcm } from "../ports/speech-port";
import type { VoiceLink } from "../ports/voice-gateway-port";

// 返事のうち、再生し終えた文、再生の途中で止めた文、再生しなかった文。
export type Spoken = Readonly<{
	played: readonly string[];
	cut: string | null;
	dropped: readonly string[];
}>;

// 返事1回分の時刻（performance.now() の値）。待ち時間の計測に使う。
export type SpeechTimings = Readonly<{
	firstSynthesizedAt: number | undefined;
	firstPlayedAt: number | undefined;
}>;

type Sentence = {
	readonly text: string;
	readonly audio: Promise<VoicePcm | undefined>;
	state: "waiting" | "playing" | "played" | "cut" | "dropped" | "failed";
};

type Playback = Pick<VoiceLink, "play" | "stop" | "setVolume">;

type SpeechOutputDependencies = Readonly<{
	synthesizer: SpeechSynthesizerPort;
	playback: Playback;
	logger: LoggerPort;
	now(): number;
}>;

// ルナの声の出口。同時に話す返事は1つだけで、新しい返事を始めると前の返事は止まる。
export class SpeechOutput {
	readonly #synthesis = new SerialQueue();
	#active: SpeechReply | undefined;

	constructor(private readonly dependencies: SpeechOutputDependencies) {}

	get speaking(): boolean {
		return this.#active?.playing ?? false;
	}

	begin(): SpeechReply {
		this.#active?.cancel();
		const reply = new SpeechReply(this.#synthesis, this.dependencies, () => {
			if (this.#active === reply) this.#active = undefined;
		});
		this.#active = reply;
		return reply;
	}

	setVolume(volume: number): void {
		this.dependencies.playback.setVolume(volume);
	}
}

export class SpeechReply {
	readonly #sentences: Sentence[] = [];
	readonly #done = Promise.withResolvers<Spoken>();
	#wake: (() => void) | undefined;
	#released = false;
	#finished = false;
	#cancelled = false;
	#settled = false;
	#firstSynthesizedAt: number | undefined;
	#firstPlayedAt: number | undefined;

	constructor(
		private readonly synthesis: SerialQueue,
		private readonly dependencies: SpeechOutputDependencies,
		private readonly onSettled: () => void,
	) {}

	get done(): Promise<Spoken> {
		return this.#done.promise;
	}

	get playing(): boolean {
		return this.#sentences.some((sentence) => sentence.state === "playing");
	}

	get released(): boolean {
		return this.#released;
	}

	get timings(): SpeechTimings {
		return { firstSynthesizedAt: this.#firstSynthesizedAt, firstPlayedAt: this.#firstPlayedAt };
	}

	// 読み上げ中の文。
	current(): string | undefined {
		return this.#sentences.find((sentence) => sentence.state === "playing")?.text;
	}

	// すぐ合成を始め、再生は release の後に言った順で行う。
	add(text: string): void {
		if (this.#cancelled || this.#finished) return;
		const audio = this.synthesis
			.run(async () => {
				if (this.#cancelled) return undefined;
				const pcm = await this.dependencies.synthesizer.synthesize(text);
				this.#firstSynthesizedAt ??= this.dependencies.now();
				return pcm;
			})
			.catch((error: unknown) => {
				this.dependencies.logger.error("voice.speech.synthesis_failed", {
					error,
					chars: text.length,
				});
				return undefined;
			});
		this.#sentences.push({ text, audio, state: "waiting" });
		this.#wakeUp();
	}

	release(): void {
		if (this.#released || this.#cancelled) return;
		this.#released = true;
		void this.#drain();
	}

	// これ以上の文は来ない。
	finish(): void {
		this.#finished = true;
		this.#wakeUp();
		if (this.#released || this.#sentences.length > 0) return;
		this.#settle();
	}

	// 再生中の文を止め、残りを捨てる。
	cancel(): Spoken {
		if (!this.#cancelled && !this.#settled) {
			this.#cancelled = true;
			const playing = this.playing;
			for (const sentence of this.#sentences) {
				if (sentence.state === "playing") sentence.state = "cut";
				else if (sentence.state === "waiting") sentence.state = "dropped";
			}
			if (playing) this.dependencies.playback.stop();
			this.#wakeUp();
			this.#settle();
		}
		return this.#spoken();
	}

	// await の間に cancel で変わるため、読むたびに確かめる。
	#isCancelled(): boolean {
		return this.#cancelled;
	}

	async #drain(): Promise<void> {
		try {
			for (let index = 0; !this.#cancelled; index += 1) {
				const sentence = await this.#next(index);
				if (sentence === undefined) break;
				const audio = await sentence.audio;
				if (this.#isCancelled()) break;
				if (audio === undefined) {
					sentence.state = "failed";
					continue;
				}
				sentence.state = "playing";
				this.#firstPlayedAt ??= this.dependencies.now();
				const completed = await this.dependencies.playback.play(audio);
				if (this.#isCancelled()) break;
				sentence.state = completed ? "played" : "cut";
				if (!completed) break;
			}
		} catch (error: unknown) {
			this.dependencies.logger.error("voice.speech.playback_failed", { error });
			for (const sentence of this.#sentences) {
				if (sentence.state === "playing") sentence.state = "failed";
			}
		}
		this.#settle();
	}

	async #next(index: number): Promise<Sentence | undefined> {
		while (true) {
			const sentence = this.#sentences[index];
			if (sentence !== undefined) return sentence;
			if (this.#finished || this.#cancelled) return undefined;
			await new Promise<void>((resolve) => {
				this.#wake = resolve;
			});
		}
	}

	#wakeUp(): void {
		const wake = this.#wake;
		this.#wake = undefined;
		wake?.();
	}

	#settle(): void {
		if (this.#settled) return;
		this.#settled = true;
		for (const sentence of this.#sentences) {
			if (sentence.state === "waiting") sentence.state = "dropped";
		}
		this.onSettled();
		this.#done.resolve(this.#spoken());
	}

	#spoken(): Spoken {
		return {
			played: this.#sentences.filter((s) => s.state === "played").map((s) => s.text),
			cut: this.#sentences.find((s) => s.state === "cut")?.text ?? null,
			dropped: this.#sentences.filter((s) => s.state === "dropped").map((s) => s.text),
		};
	}
}
