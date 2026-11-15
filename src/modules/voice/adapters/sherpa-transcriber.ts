import { readdir } from "node:fs/promises";
import { join } from "node:path";

import sherpa from "sherpa-onnx-node";
import type { OfflineRecognizer, OfflineRecognizerConfig } from "sherpa-onnx-node";
import { z } from "zod";

import { SerialQueue } from "../../../shared/serial-queue";
import type { VoiceSetting } from "../../workspace/domain/workspace-config";
import type { TranscriberPort, Transcription } from "../ports/transcriber-port";

type SherpaModelKind = VoiceSetting["sttModelKind"];

const SAMPLE_RATE = 16_000;
const ResultSchema = z.object({ text: z.string() });

// 認識はCPUを使い切るので、同時に話す人がいても1つずつデコードする。
export class SherpaTranscriber implements TranscriberPort {
	readonly #queue = new SerialQueue();

	private constructor(private readonly recognizer: OfflineRecognizer) {}

	static async create(
		input: Readonly<{ kind: SherpaModelKind; modelDir: string; numThreads: number }>,
	): Promise<SherpaTranscriber> {
		const config = await buildConfig(input.kind, input.modelDir, input.numThreads);
		return new SherpaTranscriber(await sherpa.OfflineRecognizer.createAsync(config));
	}

	transcribe(samples: Float32Array): Promise<Transcription> {
		return this.#queue.run(async () => {
			const startedAt = performance.now();
			const stream = this.recognizer.createStream();
			stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
			const result = ResultSchema.parse(await this.recognizer.decodeAsync(stream));
			return { text: result.text.trim(), elapsedMs: Math.round(performance.now() - startedAt) };
		});
	}
}

async function buildConfig(
	kind: SherpaModelKind,
	modelDir: string,
	numThreads: number,
): Promise<OfflineRecognizerConfig> {
	const files = await readdir(modelDir);
	const pick = (pattern: RegExp): string => {
		const matches = files.filter((file) => pattern.test(file)).toSorted(preferQuantized);
		const [first] = matches;
		if (first === undefined) throw new Error(`no file matching ${pattern} in ${modelDir}`);
		return join(modelDir, first);
	};
	const common = { tokens: pick(/^tokens\.txt$/u), numThreads, provider: "cpu", debug: 0 } as const;
	if (kind === "nemo-ctc") {
		return {
			featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
			modelConfig: { ...common, nemoCtc: { model: pick(/^model.*\.onnx$/u) } },
		};
	}
	return {
		featConfig: { sampleRate: SAMPLE_RATE, featureDim: kind === "nemo-transducer" ? 128 : 80 },
		modelConfig: {
			...common,
			transducer: {
				encoder: pick(/^encoder.*\.onnx$/u),
				decoder: pick(/^decoder.*\.onnx$/u),
				joiner: pick(/^joiner.*\.onnx$/u),
			},
			...(kind === "nemo-transducer" ? { modelType: "nemo_transducer" } : {}),
		},
	};
}

// 同じ部品に量子化版と非量子化版が並ぶ配布物では、CPU向けの量子化版を選ぶ。
function preferQuantized(a: string, b: string): number {
	const rank = (file: string): number => (/int8|quantized/u.test(file) ? 0 : 1);
	return rank(a) - rank(b) || a.localeCompare(b);
}
