import { SerialQueue } from "../../../shared/serial-queue";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type { InterruptedSpeech } from "../domain/voice-event";
import type { SpeechSynthesizerPort, VoicePcm } from "../ports/speech-port";

type Playback = Readonly<{
	play(audio: VoicePcm): Promise<boolean>;
	stop(): void;
}>;

type QueuedSpeech = { text: string; audio: Promise<VoicePcm | undefined>; playing: boolean };

// ルナの発言を言った順に再生する。次の文の合成は前の文の再生中に進めておく。
export class SpeechQueue {
	readonly #synthesis = new SerialQueue();
	#queue: QueuedSpeech[] = [];
	#current: QueuedSpeech | undefined;
	#played: string[] = [];
	#generation = 0;
	#draining = false;

	constructor(
		private readonly dependencies: Readonly<{
			synthesizer: SpeechSynthesizerPort;
			playback: Playback;
			logger: LoggerPort;
		}>,
	) {}

	get busy(): boolean {
		return this.#current !== undefined || this.#queue.length > 0;
	}

	say(text: string): void {
		const generation = this.#generation;
		const audio = this.#synthesis
			.run(async () => {
				// 遮られて捨てた発言は合成しない。
				if (generation !== this.#generation) return undefined;
				return await this.dependencies.synthesizer.synthesize(text);
			})
			.catch((error: unknown) => {
				this.dependencies.logger.error("voice.speech.synthesis_failed", {
					error,
					chars: text.length,
				});
				return undefined;
			});
		this.#queue.push({ text, audio, playing: false });
		void this.#drain();
	}

	// 人の発話を会話に渡すたびに呼び、遮られた時に返す「話し終えた発言」をその後の分に限る。
	markTurn(): void {
		this.#played = [];
	}

	// 再生中と再生待ちの発言を止めて捨てる。話していなければ undefined を返す。
	interrupt(): InterruptedSpeech | undefined {
		const current = this.#current;
		if (current === undefined && this.#queue.length === 0) return undefined;
		const pending =
			current !== undefined && !current.playing ? [current, ...this.#queue] : this.#queue;
		const interrupted: InterruptedSpeech = {
			played: this.#played,
			cut: current?.playing === true ? current.text : null,
			dropped: pending.map((speech) => speech.text),
		};
		this.#generation += 1;
		this.#queue = [];
		this.#played = [];
		this.dependencies.playback.stop();
		return interrupted;
	}

	clear(): void {
		this.interrupt();
	}

	async #drain(): Promise<void> {
		if (this.#draining) return;
		this.#draining = true;
		try {
			for (let next = this.#queue.shift(); next !== undefined; next = this.#queue.shift()) {
				const generation = this.#generation;
				this.#current = next;
				const audio = await next.audio;
				if (audio === undefined || generation !== this.#generation) continue;
				next.playing = true;
				const completed = await this.dependencies.playback.play(audio);
				if (completed && generation === this.#generation) this.#played.push(next.text);
			}
		} catch (error: unknown) {
			this.dependencies.logger.error("voice.speech.playback_failed", { error });
		} finally {
			this.#current = undefined;
			this.#draining = false;
		}
		if (this.#queue.length > 0) void this.#drain();
	}
}
