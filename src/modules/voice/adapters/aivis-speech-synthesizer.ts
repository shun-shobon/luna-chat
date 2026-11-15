import { z } from "zod";

import type { SpeechSynthesizerPort, VoicePcm } from "../ports/speech-port";

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
		return { pcm: readPcmWav(Buffer.from(await synthesisResponse.arrayBuffer())) };
	}
}

function readPcmWav(wav: Buffer): Buffer {
	if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error("not a WAV file");
	}
	let offset = 12;
	let format: Readonly<{ channels: number; sampleRate: number; bits: number }> | undefined;
	while (offset + 8 <= wav.length) {
		const id = wav.toString("ascii", offset, offset + 4);
		const size = wav.readUInt32LE(offset + 4);
		const body = offset + 8;
		if (id === "fmt ") {
			format = {
				channels: wav.readUInt16LE(body + 2),
				sampleRate: wav.readUInt32LE(body + 4),
				bits: wav.readUInt16LE(body + 14),
			};
		} else if (id === "data") {
			if (
				format?.channels !== CHANNELS ||
				format.sampleRate !== SAMPLE_RATE ||
				format.bits !== BITS_PER_SAMPLE
			) {
				throw new Error(`unexpected WAV format: ${JSON.stringify(format)}`);
			}
			return wav.subarray(body, Math.min(body + size, wav.length));
		}
		// チャンクは偶数バイト境界にそろえて並ぶ。
		offset = body + size + (size % 2);
	}
	throw new Error("WAV has no data chunk");
}
