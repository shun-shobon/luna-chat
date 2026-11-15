// 48kHzステレオの符号付き16bitリトルエンディアンPCM。Discordへ送る形にそのまま合わせる。
export type VoicePcm = Readonly<{ pcm: Buffer }>;

export interface SpeechSynthesizerPort {
	synthesize(text: string): Promise<VoicePcm>;
}
