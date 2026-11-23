import { vi } from "vitest";
import type { Mock } from "vitest";

import type { ModelStream, ModelStreamEvent } from "../../agent/ports/outbound/model-stream-port";
import type { SpeechSynthesizerPort, VoicePcm } from "../ports/speech-port";
import type { TranscriberPort } from "../ports/transcriber-port";
import type { VoiceLink } from "../ports/voice-gateway-port";

export type FakeVoices = Readonly<{
	// 認識すると text になる音声。nonVerbal なら声以外の音として認識する。
	voice(text: string, options?: Readonly<{ nonVerbal?: boolean }>): Float32Array;
	transcriber: Readonly<{ transcribe: Mock<TranscriberPort["transcribe"]> }>;
}>;

// 発話ごとに別の値で埋めた音声を作り、つなげた音声はつなげた文字列として認識する。
export function createFakeVoices(): FakeVoices {
	const sounds: Array<Readonly<{ text: string; nonVerbal: boolean }>> = [];
	return {
		voice: (text, options = {}) => {
			const code = sounds.push({ text, nonVerbal: options.nonVerbal ?? false });
			return new Float32Array(160).fill(code);
		},
		transcriber: {
			transcribe: vi.fn<TranscriberPort["transcribe"]>((samples) => {
				const heard: Array<Readonly<{ text: string; nonVerbal: boolean }>> = [];
				let last: number | undefined;
				for (const code of samples) {
					if (code === last) continue;
					last = code;
					const sound = sounds[code - 1];
					if (sound === undefined) throw new Error(`Unknown sound ${String(code)}`);
					heard.push(sound);
				}
				const verbal = heard.filter((sound) => !sound.nonVerbal);
				return Promise.resolve({
					text: verbal.map((sound) => sound.text).join(""),
					nonVerbal: verbal.length === 0 && heard.length > 0,
					elapsedMs: 40,
				});
			}),
		},
	};
}

type FrontCall = Readonly<{
	prompt: string;
	signal: AbortSignal;
	// <voice_record> の中の行。
	recordLines(): string[];
	say(delta: string): void;
	toolCall(name: string, args: unknown): void;
	delegate(request: string): void;
	end(): void;
	fail(error: Error): void;
}>;

export type FakeFront = Readonly<{
	stream: ModelStream;
	calls: FrontCall[];
	closed(): boolean;
}>;

type Item =
	| Readonly<{ kind: "event"; event: ModelStreamEvent }>
	| Readonly<{ kind: "end" }>
	| Readonly<{ kind: "fail"; error: Error }>;

// 表のモデルの代わり。要求ごとに、返す文字やツール呼び出しをテストから流す。
export function createFakeFront(): FakeFront {
	const calls: FrontCall[] = [];
	let closed = false;
	return {
		calls,
		closed: () => closed,
		stream: {
			stream: (prompt, signal) => {
				const queue: Item[] = [];
				let wake: (() => void) | undefined;
				const push = (item: Item): void => {
					queue.push(item);
					wake?.();
				};
				calls.push({
					prompt,
					signal,
					recordLines: () => {
						const match = /<voice_record>\n([\s\S]*)\n<\/voice_record>/u.exec(prompt);
						const body = match?.[1] ?? "";
						return body === "" ? [] : body.split("\n");
					},
					say: (delta) => push({ kind: "event", event: { type: "text", delta } }),
					toolCall: (name, args) =>
						push({ kind: "event", event: { type: "tool_call", name, arguments: args } }),
					delegate: (request) =>
						push({
							kind: "event",
							event: { type: "tool_call", name: "delegate", arguments: { request } },
						}),
					end: () => push({ kind: "end" }),
					fail: (error) => push({ kind: "fail", error }),
				});
				signal.addEventListener("abort", () => wake?.(), { once: true });
				const arrival = (): Promise<void> =>
					new Promise((resolve) => {
						wake = resolve;
					});
				return (async function* () {
					while (true) {
						if (signal.aborted) throw signal.reason;
						const item = queue.shift();
						if (item === undefined) {
							await arrival();
							continue;
						}
						if (item.kind === "end") return;
						if (item.kind === "fail") throw item.error;
						yield item.event;
					}
				})();
			},
			close: () => {
				closed = true;
				return Promise.resolve();
			},
		},
	};
}

type Play = Readonly<{ text: string; done: PromiseWithResolvers<boolean> }>;

export type FakePlayback = Pick<VoiceLink, "play" | "stop" | "setVolume"> &
	Readonly<{
		plays: Play[];
		volumes: number[];
		stops(): number;
		// 再生中の文を最後まで再生し終える。
		finishPlaying(): void;
	}>;

// 合成した音声は元の文字列のまま持ち、再生は finishPlaying か stop まで終わらない。
export const textSynthesizer: SpeechSynthesizerPort = {
	synthesize: (text): Promise<VoicePcm> => Promise.resolve({ pcm: Buffer.from(text) }),
};

export function createFakePlayback(): FakePlayback {
	const plays: Play[] = [];
	const volumes: number[] = [];
	let stops = 0;
	return {
		plays,
		volumes,
		stops: () => stops,
		play: (audio) => {
			const done = Promise.withResolvers<boolean>();
			plays.push({ text: audio.pcm.toString(), done });
			return done.promise;
		},
		stop: () => {
			stops += 1;
			plays.at(-1)?.done.resolve(false);
		},
		setVolume: (volume) => {
			volumes.push(volume);
		},
		finishPlaying: () => {
			plays.at(-1)?.done.resolve(true);
		},
	};
}

export async function flush(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}
