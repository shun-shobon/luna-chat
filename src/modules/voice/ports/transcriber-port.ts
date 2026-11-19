export type Transcription = Readonly<{
	text: string;
	// 声ではなく笑い声・咳・物音などと認識器が判定した。音の種類を判定しない認識器では常に false。
	nonVerbal: boolean;
	elapsedMs: number;
}>;

export interface TranscriberPort {
	// samples は16kHzモノラル、[-1, 1] の範囲。
	transcribe(samples: Float32Array): Promise<Transcription>;
}
