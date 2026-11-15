// sherpa-onnx-node は型定義を同梱しないため、使う範囲だけを宣言する。
declare module "sherpa-onnx-node" {
	type OfflineRecognizerConfig = Readonly<{
		featConfig: Readonly<{ sampleRate: number; featureDim: number }>;
		modelConfig: Readonly<{
			nemoCtc?: Readonly<{ model: string }>;
			transducer?: Readonly<{ encoder: string; decoder: string; joiner: string }>;
			modelType?: string;
			tokens: string;
			numThreads: number;
			provider: "cpu";
			debug: number;
		}>;
	}>;

	class OfflineStream {
		acceptWaveform(input: Readonly<{ samples: Float32Array; sampleRate: number }>): void;
	}

	class OfflineRecognizer {
		static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>;
		createStream(): OfflineStream;
		decodeAsync(stream: OfflineStream): Promise<unknown>;
	}

	type VadConfig = Readonly<{
		sileroVad: Readonly<{
			model: string;
			threshold: number;
			minSilenceDuration: number;
			minSpeechDuration: number;
			maxSpeechDuration: number;
			windowSize: number;
		}>;
		sampleRate: number;
		numThreads: number;
		provider: "cpu";
		debug: number;
	}>;

	class Vad {
		constructor(config: VadConfig, bufferSizeInSeconds: number);
		acceptWaveform(samples: Float32Array): void;
		isEmpty(): boolean;
		isDetected(): boolean;
		front(enableExternalBuffer: boolean): unknown;
		pop(): void;
		flush(): void;
		reset(): void;
	}

	const sherpa: Readonly<{ OfflineRecognizer: typeof OfflineRecognizer; Vad: typeof Vad }>;
	export default sherpa;
	export type { OfflineRecognizer, OfflineRecognizerConfig, Vad };
}
