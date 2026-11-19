import { z } from "zod";

import type { SpeechSynthesizerPort, VoicePcm } from "../ports/speech-port";
import { readPcmWav } from "./wav";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;

// AudioQuery はエンジンの版で項目が増えるので、知らない項目もそのまま送り返す。
const AudioQuerySchema = z.looseObject({});

// VOICEVOX互換のHTTP API（AivisSpeech Engine など）で読み上げる。
export class AivisSpeechSynthesizer implements SpeechSynthesizerPort {
	constructor(
		private readonly baseUrl: URL,
		private readonly speaker: number,
		private readonly speedScale: number,
	) {}

	async synthesize(text: string): Promise<VoicePcm> {
		const queryUrl = new URL("audio_query", this.baseUrl);
		queryUrl.searchParams.set("text", text);
		queryUrl.searchParams.set("speaker", String(this.speaker));
		const queryResponse = await fetch(queryUrl, { method: "POST" });
		if (!queryResponse.ok) {
			throw new Error(`audio_query failed: ${queryResponse.status} ${await queryResponse.text()}`);
		}
		const query = AudioQuerySchema.parse(await queryResponse.json());

		const synthesisUrl = new URL("synthesis", this.baseUrl);
		synthesisUrl.searchParams.set("speaker", String(this.speaker));
		const synthesisResponse = await fetch(synthesisUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			// Discordへ送る48kHzステレオで出させ、自前のリサンプルを持たない。
			body: JSON.stringify({
				...query,
				speedScale: this.speedScale,
				outputSamplingRate: SAMPLE_RATE,
				outputStereo: true,
			}),
		});
		if (!synthesisResponse.ok) {
			throw new Error(
				`synthesis failed: ${synthesisResponse.status} ${await synthesisResponse.text()}`,
			);
		}
		const { format, pcm } = readPcmWav(Buffer.from(await synthesisResponse.arrayBuffer()));
		if (
			format.channels !== CHANNELS ||
			format.sampleRate !== SAMPLE_RATE ||
			format.bits !== BITS_PER_SAMPLE
		) {
			throw new Error(`unexpected WAV format: ${JSON.stringify(format)}`);
		}
		return { pcm };
	}
}
