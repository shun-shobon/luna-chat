import sherpa from "sherpa-onnx-node";
import type { Vad } from "sherpa-onnx-node";

export const VAD_SAMPLE_RATE = 16_000;
export const VAD_WINDOW_SIZE = 512;
// 1回分の発話がこれより長くても、区間は都度取り出すので溢れない。
const BUFFER_SECONDS = 60;

export function createSileroVad(model: string): Vad {
	return new sherpa.Vad(
		{
			sileroVad: {
				model,
				threshold: 0.5,
				minSilenceDuration: 0.3,
				minSpeechDuration: 0.25,
				maxSpeechDuration: 30,
				windowSize: VAD_WINDOW_SIZE,
			},
			sampleRate: VAD_SAMPLE_RATE,
			numThreads: 1,
			provider: "cpu",
			debug: 0,
		},
		BUFFER_SECONDS,
	);
}

export type SpeechDetector = Readonly<{
	// 発話の始めに呼び、前の発話の状態を捨てる。
	reset(): void;
	// 受け取った音声までに声を検知していれば true。
	accept(samples: Float32Array): boolean;
}>;

// 話者ごとに1つ持ち、読み上げを止める合図になる「人の声」を音声の受信中に見つける。
export function createSpeechDetector(model: string): SpeechDetector {
	const vad = createSileroVad(model);
	let pending = new Float32Array(0);
	let detected = false;
	return {
		reset: () => {
			vad.reset();
			pending = new Float32Array(0);
			detected = false;
		},
		accept: (samples) => {
			if (detected) return true;
			const buffer = new Float32Array(pending.length + samples.length);
			buffer.set(pending);
			buffer.set(samples, pending.length);
			let offset = 0;
			for (; offset + VAD_WINDOW_SIZE <= buffer.length; offset += VAD_WINDOW_SIZE) {
				vad.acceptWaveform(buffer.subarray(offset, offset + VAD_WINDOW_SIZE));
			}
			pending = buffer.slice(offset);
			detected = !vad.isEmpty() || vad.isDetected();
			return detected;
		},
	};
}
