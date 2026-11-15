export type Transcription = Readonly<{ text: string; elapsedMs: number }>;

export interface TranscriberPort {
	// samples は16kHzモノラル、[-1, 1] の範囲。
	transcribe(samples: Float32Array): Promise<Transcription>;
}
