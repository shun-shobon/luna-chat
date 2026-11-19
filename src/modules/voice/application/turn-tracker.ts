import type { LoggerPort } from "../../observability/ports/logger-port";
import { looksUnfinished } from "../domain/turn-text";
import type { TranscriberPort, Transcription } from "../ports/transcriber-port";

const SAMPLE_RATE = 16_000;

// 1人の話者がひと続きに話した内容。区切りごとに音声をつなげて認識し直す。
export type Turn = Readonly<{
	userId: string;
	speaker: string;
	text: string;
	// 同じ話者の区切りを受けるたびに増える。先行生成がどの版に対するものかを見分ける。
	version: number;
	// 話し終えた時刻の見積もり（区切れた時刻から silence_ms を引いたもの、performance.now() の値）。
	speechEndedAt: number;
	sttMs: number;
}>;

type TurnTrackerDependencies = Readonly<{
	transcriber: TranscriberPort;
	speakerName(userId: string): Promise<string>;
	logger: LoggerPort;
	now(): number;
	silenceMs: number;
	turnWaitMs: number;
	unfinishedTurnWaitMs: number;
}>;

export type TurnHandlers = Readonly<{
	// 区切りを認識した。まだターンの終わりとは限らない。
	onDraft(turn: Turn): void;
	onCommit(turn: Turn): void;
	// 待っていた話者の続きが、声のない音だけだった。
	onDiscard(userId: string): void;
}>;

type Pending = {
	samples: Float32Array;
	turn: Turn | undefined;
	version: number;
	// 話者が続きを話している間は、ターンの確定を待たない。
	continuing: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
};

// 話者ごとに区切りをつなげ、続きが来なければターンを確定する。
export class TurnTracker {
	readonly #pending = new Map<string, Pending>();

	constructor(
		private readonly dependencies: TurnTrackerDependencies,
		private readonly handlers: TurnHandlers,
	) {}

	get idle(): boolean {
		return this.#pending.size === 0;
	}

	speechStarted(userId: string): void {
		const pending = this.#pending.get(userId);
		if (pending === undefined) return;
		clearTimeout(pending.timer);
		pending.timer = undefined;
		pending.continuing = true;
	}

	async segment(userId: string, samples: Float32Array): Promise<void> {
		const arrivedAt = this.dependencies.now();
		const pending = this.#pending.get(userId) ?? {
			samples: new Float32Array(0),
			turn: undefined,
			version: 0,
			continuing: false,
			timer: undefined,
		};
		this.#pending.set(userId, pending);
		clearTimeout(pending.timer);
		pending.timer = undefined;
		pending.continuing = false;
		pending.samples = concat(pending.samples, samples);
		pending.version += 1;
		const version = pending.version;

		let result: Transcription;
		let speaker: string;
		try {
			[result, speaker] = await Promise.all([
				this.dependencies.transcriber.transcribe(pending.samples),
				this.dependencies.speakerName(userId),
			]);
		} catch (error: unknown) {
			// 待ったままにすると、前の区切りまでのターンが確定しなくなる。
			if (this.#pending.get(userId) === pending && pending.version === version) {
				this.#skipSegment(userId, pending);
			}
			throw error;
		}
		this.dependencies.logger.info("voice.segment.transcribed", {
			userId,
			durationSec: pending.samples.length / SAMPLE_RATE,
			sttMs: result.elapsedMs,
			chars: result.text.length,
			nonVerbal: result.nonVerbal,
		});
		if (this.#pending.get(userId) !== pending || pending.version !== version) return;

		if (result.text === "" || result.nonVerbal) {
			this.#skipSegment(userId, pending);
			return;
		}
		pending.turn = {
			userId,
			speaker,
			text: result.text,
			version,
			speechEndedAt: arrivedAt - this.dependencies.silenceMs,
			sttMs: result.elapsedMs,
		};
		this.handlers.onDraft(pending.turn);
		if (!isContinuing(pending)) this.#arm(userId, pending);
	}

	dispose(): void {
		for (const pending of this.#pending.values()) clearTimeout(pending.timer);
		this.#pending.clear();
	}

	// 何も足さない区切り。前の区切りまでのターンがあればそれを確定へ回す。
	#skipSegment(userId: string, pending: Pending): void {
		if (pending.turn === undefined) {
			this.#pending.delete(userId);
			this.handlers.onDiscard(userId);
			return;
		}
		if (!pending.continuing) this.#arm(userId, pending);
	}

	#arm(userId: string, pending: Pending): void {
		const turn = pending.turn;
		if (turn === undefined) return;
		const waitMs = looksUnfinished(turn.text)
			? this.dependencies.unfinishedTurnWaitMs
			: this.dependencies.turnWaitMs;
		pending.timer = setTimeout(() => {
			if (this.#pending.get(userId) !== pending) return;
			this.#pending.delete(userId);
			this.handlers.onCommit(turn);
		}, waitMs);
	}
}

// 認識を待つ間に speechStarted で変わるため、読むたびに確かめる。
function isContinuing(pending: Pending): boolean {
	return pending.continuing;
}

function concat(left: Float32Array, right: Float32Array): Float32Array {
	const out = new Float32Array(left.length + right.length);
	out.set(left);
	out.set(right, left.length);
	return out;
}
