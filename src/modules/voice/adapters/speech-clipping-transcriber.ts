import type { Vad } from "sherpa-onnx-node";
import { z } from "zod";

import type { TranscriberPort, Transcription } from "../ports/transcriber-port";
import { VAD_SAMPLE_RATE, VAD_WINDOW_SIZE, createSileroVad } from "./silero-vad";

// 発話の頭と末尾の子音を切り落とさないよう、声の区間の前後を少し残す。
const PAD_SAMPLES = VAD_SAMPLE_RATE * 0.2;
const SegmentSchema = z.object({
	start: z.number().int().min(0),
	samples: z.instanceof(Float32Array),
});

// 声の区間だけを残して認識に渡す。声がなければ認識せず空を返し、雑音からの誤認識を防ぐ。
export class SpeechClippingTranscriber implements TranscriberPort {
	private constructor(
		private readonly vad: Vad,
		private readonly inner: TranscriberPort,
	) {}

	static create(vadModel: string, inner: TranscriberPort): SpeechClippingTranscriber {
		return new SpeechClippingTranscriber(createSileroVad(vadModel), inner);
	}

	async transcribe(samples: Float32Array): Promise<Transcription> {
		const startedAt = performance.now();
		const speech = this.#clip(samples);
		if (speech.length === 0) {
			return { text: "", nonVerbal: false, elapsedMs: Math.round(performance.now() - startedAt) };
		}
		const result = await this.inner.transcribe(speech);
		return { ...result, elapsedMs: Math.round(performance.now() - startedAt) };
	}

	// 同期処理で終わるので、他の呼び出しと VAD の状態が混ざることはない。
	#clip(samples: Float32Array): Float32Array {
		this.vad.reset();
		const ranges: Array<[number, number]> = [];
		const collect = (): void => {
			while (!this.vad.isEmpty()) {
				const segment = SegmentSchema.parse(this.vad.front(false));
				this.vad.pop();
				const from = Math.max(0, segment.start - PAD_SAMPLES);
				const to = Math.min(samples.length, segment.start + segment.samples.length + PAD_SAMPLES);
				const last = ranges.at(-1);
				if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
				else ranges.push([from, to]);
			}
		};
		for (let offset = 0; offset < samples.length; offset += VAD_WINDOW_SIZE) {
			this.vad.acceptWaveform(samples.subarray(offset, offset + VAD_WINDOW_SIZE));
			collect();
		}
		this.vad.flush();
		collect();

		const out = new Float32Array(ranges.reduce((sum, [from, to]) => sum + to - from, 0));
		let offset = 0;
		for (const [from, to] of ranges) {
			out.set(samples.subarray(from, to), offset);
			offset += to - from;
		}
		return out;
	}
}
