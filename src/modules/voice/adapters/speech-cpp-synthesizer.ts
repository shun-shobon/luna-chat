import type { SpeechSynthesizerPort, VoicePcm } from "../ports/speech-port";
import { monoToStereo, readPcmWav } from "./wav";

const SAMPLE_RATE = 48_000;
const BITS_PER_SAMPLE = 16;

// speech.cpp の OpenAI 互換 API（POST /v1/audio/speech）で読み上げる。声はサーバーの起動時に登録した名前で選ぶ。
export class SpeechCppSynthesizer implements SpeechSynthesizerPort {
	constructor(
		private readonly input: Readonly<{
			baseUrl: URL;
			voice: string;
			speed: number;
			// 別のホストが落ちていると接続の待ちが長引くので、1文ごとに打ち切る。
			timeoutMs: number;
		}>,
	) {}

	async synthesize(text: string): Promise<VoicePcm> {
		const response = await fetch(new URL("v1/audio/speech", this.input.baseUrl), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				input: text,
				voice: this.input.voice,
				speed: this.input.speed,
				response_format: "wav",
			}),
			signal: AbortSignal.timeout(this.input.timeoutMs),
		});
		if (!response.ok) {
			throw new Error(`speech.cpp synthesis failed: ${response.status} ${await response.text()}`);
		}
		const { format, pcm } = readPcmWav(Buffer.from(await response.arrayBuffer()));
		if (
			format.sampleRate !== SAMPLE_RATE ||
			format.bits !== BITS_PER_SAMPLE ||
			(format.channels !== 1 && format.channels !== 2)
		) {
			throw new Error(`unexpected WAV format: ${JSON.stringify(format)}`);
		}
		// Irodori はモノラルで返す。Discordへ送る48kHzステレオにそろえる。
		return { pcm: format.channels === 1 ? monoToStereo(pcm) : pcm };
	}
}
