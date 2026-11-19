import type { VoiceChannelRef } from "../domain/voice-event";
import type { VoicePcm } from "./speech-port";

export type VoiceLinkHandlers = Readonly<{
	// 話者の音声が silence_ms 途切れて区切れた1回分。声を検知した区切りだけが来る。ターンの終わりとは限らない。16kHzモノラル。
	onSegment(userId: string, samples: Float32Array): void;
	// 話者の声を検知した。区切りの途中の待ちを止めたり、割り込みかを判定し始める合図に使う。
	onSpeechStarted(userId: string): void;
	// VCにいるBot以外の人数が変わった。
	onHumanCount(count: number): void;
	// Discord側の切断などで、つながりが戻らなくなった。
	onClosed(): void;
}>;

export interface VoiceLink {
	readonly humanCount: number;
	// 再生し終えたら true、stop で止めたら false で解決する。同時に再生するのは1つだけ。
	play(audio: VoicePcm): Promise<boolean>;
	stop(): void;
	// 再生中と以後の再生の音量（0〜1）。
	setVolume(volume: number): void;
	// 話者がまだ区切れていない発話の、ここまでに受信した音声。受信していなければ undefined。
	ongoingSpeech(userId: string): Float32Array | undefined;
	// テキストモードでは話さないことが見て分かるよう、自分をミュートにする。
	setMuted(muted: boolean): void;
	disconnect(): void;
}

export interface VoiceGatewayPort {
	// 入れるVCか確かめる。VCでない、接続や発言の権限がない場合は失敗する。
	resolveChannel(channelId: string): Promise<VoiceChannelRef>;
	// その人が今いるVC。いなければ失敗する。
	findUserChannel(userId: string): Promise<VoiceChannelRef>;
	connect(
		channel: VoiceChannelRef,
		handlers: VoiceLinkHandlers,
		options: Readonly<{ muted: boolean }>,
	): Promise<VoiceLink>;
	speakerName(channel: VoiceChannelRef, userId: string): Promise<string>;
}
