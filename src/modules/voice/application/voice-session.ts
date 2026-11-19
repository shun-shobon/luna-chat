import type { LoggerPort } from "../../observability/ports/logger-port";
import { SentenceSplitter } from "../domain/sentence-splitter";
import { VoiceRecord } from "../domain/voice-record";
import type { VoiceRecordEntry } from "../domain/voice-record";
import type { InterruptClassifierPort } from "../ports/interrupt-classifier-port";
import type { TranscriberPort } from "../ports/transcriber-port";
import { InterruptJudge } from "./interrupt-judge";
import type { SpeechOutput, SpeechReply, Spoken } from "./speech-output";
import type { Turn, TurnTracker } from "./turn-tracker";
import type { ResponderTrigger, VoiceResponder } from "./voice-responder";

// 表に渡す会話記録の長さ。古い話題まで読ませると返事が遅くなる。
const RECORD_ENTRIES_FOR_FRONT = 40;
// 声が重なった間の読み上げの音量。止めずに、話している人の声を聞き取りやすくする。
const DUCKED_VOLUME = 0.3;
const EARLY_CHECK_MS = 1000;

type VoiceSessionDependencies = Readonly<{
	responder: VoiceResponder;
	output: SpeechOutput;
	transcriber: TranscriberPort;
	classifier: InterruptClassifierPort;
	ongoingSpeech(userId: string): Float32Array | undefined;
	speakerName(userId: string): Promise<string>;
	back: Readonly<{
		// 裏（会話のルナ）に頼む。transcript は裏へまだ渡していない会話記録。
		// 会話が受け付けたら true。受け付けなかった会話記録は次の依頼か閉じる時に渡し直す。
		delegate(request: string, transcript: readonly VoiceRecordEntry[]): boolean;
		// 裏が依頼を進めている間だけ発話を届ける。届けたら true。
		hear(turn: Turn): boolean;
	}>;
	logger: LoggerPort;
	now(): number;
	clock(): Date;
}>;

type Reply = {
	readonly speech: SpeechReply;
	readonly controller: AbortController;
	readonly trigger: ResponderTrigger;
	// 返事の相手のターン。ターン確定の前に作り始めた返事（先行生成）では、確定前の版。
	readonly turn: Turn | undefined;
	readonly pregenerated: boolean;
	readonly startedAt: number;
	committedAt: number | undefined;
	firstTextAt: number | undefined;
	// 確定前に出た裏への依頼。確定してから出す。
	held: string[];
	recorded: boolean;
	// 確定前に何も言わずに終わった先行生成の結果。
	settledEarly: Spoken | undefined;
};

// 音声モードの会話の進行。人の声をターンにまとめて表に返事を作らせ、読み上げ・割り込み・裏とのやりとりを受け持つ。
export class VoiceSession {
	readonly #record = new VoiceRecord();
	readonly #judge: InterruptJudge;
	readonly #speaking = new Set<string>();
	#reply: Reply | undefined;
	#unreadReport = false;
	#deliveredSeq = 0;
	#closed = false;

	constructor(
		private readonly dependencies: VoiceSessionDependencies,
		private readonly turns: TurnTracker,
	) {
		this.#judge = new InterruptJudge(
			{
				transcriber: dependencies.transcriber,
				classifier: dependencies.classifier,
				ongoingSpeech: dependencies.ongoingSpeech,
				logger: dependencies.logger,
				now: dependencies.now,
				earlyCheckMs: EARLY_CHECK_MS,
			},
			{ onInterruption: (userId) => this.#interrupt(userId) },
		);
	}

	speechStarted(userId: string): void {
		if (this.#closed) return;
		this.#speaking.add(userId);
		if (this.dependencies.output.speaking) {
			if (!this.#judge.isJudging(userId)) {
				this.#judge.start(userId, this.#reply?.speech.current() ?? "");
				this.dependencies.output.setVolume(DUCKED_VOLUME);
			}
			return;
		}
		this.turns.speechStarted(userId);
	}

	segment(userId: string, samples: Float32Array): void {
		if (this.#closed) return;
		this.#speaking.delete(userId);
		if (this.#judge.isJudging(userId)) {
			void this.#endHearing(userId, samples);
			return;
		}
		this.#forwardToTurns(userId, samples);
	}

	draft(turn: Turn): void {
		if (this.#closed) return;
		this.#startReply({ kind: "turn", speaker: turn.speaker }, turn, false);
	}

	commit(turn: Turn): void {
		if (this.#closed) return;
		this.#record.add({
			kind: "heard",
			at: this.dependencies.clock(),
			userId: turn.userId,
			speaker: turn.speaker,
			text: turn.text,
			aside: null,
		});
		if (this.dependencies.back.hear(turn) && this.#deliveredSeq === this.#record.endSeq - 1) {
			this.#deliveredSeq = this.#record.endSeq;
		}
		const reply = this.#reply;
		if (
			reply !== undefined &&
			!reply.speech.released &&
			reply.turn?.userId === turn.userId &&
			reply.turn.version === turn.version
		) {
			this.#release(reply);
			if (reply.settledEarly !== undefined) this.#finishReply(reply, reply.settledEarly);
			return;
		}
		this.#startReply({ kind: "turn", speaker: turn.speaker }, turn, true);
	}

	discard(): void {
		this.#maybeTellReport();
	}

	report(text: string): void {
		if (this.#closed) return;
		this.#record.add({ kind: "report", at: this.dependencies.clock(), text });
		this.#unreadReport = true;
		this.#maybeTellReport();
	}

	// 読み上げを止めて閉じ、裏へまだ渡していない会話記録を返す。人の声もルナの声もなければ空。
	async close(): Promise<readonly VoiceRecordEntry[]> {
		if (this.#closed) return [];
		this.#closed = true;
		this.#judge.cancelAll();
		const reply = this.#reply;
		this.#reply = undefined;
		if (reply !== undefined) this.#stopReply(reply);
		this.dependencies.output.setVolume(1);
		await this.dependencies.responder.close();
		const rest = this.#record.since(this.#deliveredSeq);
		return rest.some((entry) => entry.kind === "heard" || entry.kind === "said") ? rest : [];
	}

	#forwardToTurns(userId: string, samples: Float32Array): void {
		this.turns.segment(userId, samples).catch((error: unknown) => {
			this.dependencies.logger.error("voice.segment.failed", { userId, error });
		});
	}

	async #endHearing(userId: string, samples: Float32Array): Promise<void> {
		const hearing = await this.#judge.end(userId, samples);
		if (!this.#judge.judging) this.dependencies.output.setVolume(1);
		if (this.#closed) return;
		if (hearing.kind === "interruption") {
			this.#forwardToTurns(userId, samples);
			return;
		}
		if (hearing.kind === "aside") {
			this.#record.add({
				kind: "heard",
				at: this.dependencies.clock(),
				userId,
				speaker: await this.dependencies.speakerName(userId),
				text: hearing.text,
				aside: hearing.aside,
			});
		}
		this.#maybeTellReport();
	}

	#startReply(trigger: ResponderTrigger, turn: Turn | undefined, committed: boolean): void {
		const previous = this.#reply;
		if (previous !== undefined) this.#stopReply(previous);
		const reply: Reply = {
			speech: this.dependencies.output.begin(),
			controller: new AbortController(),
			trigger,
			turn,
			pregenerated: !committed,
			startedAt: this.dependencies.now(),
			committedAt: undefined,
			firstTextAt: undefined,
			held: [],
			recorded: false,
			settledEarly: undefined,
		};
		this.#reply = reply;
		const record = this.#record.recent(RECORD_ENTRIES_FOR_FRONT);
		const prompt: readonly VoiceRecordEntry[] =
			committed || turn === undefined
				? record
				: [
						...record,
						{
							kind: "heard",
							at: this.dependencies.clock(),
							userId: turn.userId,
							speaker: turn.speaker,
							text: turn.text,
							aside: null,
						},
					];
		if (committed) this.#release(reply);
		void reply.speech.done.then((spoken) => {
			this.#finishReply(reply, spoken);
		});
		void this.#generate(reply, prompt);
	}

	async #generate(reply: Reply, record: readonly VoiceRecordEntry[]): Promise<void> {
		const splitter = new SentenceSplitter();
		let chars = 0;
		let delegations = 0;
		let failed = false;
		try {
			for await (const event of this.dependencies.responder.respond(
				{ record, trigger: reply.trigger },
				reply.controller.signal,
			)) {
				if (event.type === "text") {
					reply.firstTextAt ??= this.dependencies.now();
					chars += event.delta.length;
					for (const sentence of splitter.push(event.delta)) reply.speech.add(sentence);
				} else {
					delegations += 1;
					if (reply.speech.released) this.#delegate(event.request);
					else reply.held.push(event.request);
				}
			}
			const rest = splitter.flush();
			if (rest !== undefined) reply.speech.add(rest);
		} catch (error: unknown) {
			if (reply.controller.signal.aborted) return;
			failed = true;
			this.dependencies.logger.error("voice.front.failed", { error });
		}
		this.dependencies.logger.info("voice.front.responded", {
			trigger: reply.trigger.kind,
			pregenerated: reply.pregenerated,
			ms: Math.round(this.dependencies.now() - reply.startedAt),
			firstTextMs: elapsed(reply.startedAt, reply.firstTextAt),
			chars,
			delegations,
			failed,
		});
		reply.speech.finish();
	}

	#release(reply: Reply): void {
		reply.committedAt = this.dependencies.now();
		reply.speech.release();
		for (const request of reply.held.splice(0)) this.#delegate(request);
	}

	#delegate(request: string): void {
		const transcript = this.#record.since(this.#deliveredSeq);
		this.#record.add({ kind: "delegated", at: this.dependencies.clock(), request });
		if (this.dependencies.back.delegate(request, transcript)) {
			this.#deliveredSeq = this.#record.endSeq;
		}
	}

	#interrupt(userId: string): void {
		const reply = this.#reply;
		this.dependencies.output.setVolume(1);
		if (reply === undefined) return;
		this.#reply = undefined;
		const spoken = this.#stopReply(reply);
		this.dependencies.logger.info("voice.speech.interrupted", { userId, ...spoken });
	}

	#stopReply(reply: Reply): Spoken {
		reply.controller.abort();
		const spoken = reply.speech.cancel();
		this.#recordSaid(reply, spoken);
		return spoken;
	}

	#finishReply(reply: Reply, spoken: Spoken): void {
		// 黙ると決めた先行生成を確定前に手放すと、確定時に表へ頼み直し、控えた依頼も失う。
		if (!reply.speech.released && this.#reply === reply) {
			reply.settledEarly = spoken;
			return;
		}
		this.#recordSaid(reply, spoken);
		this.#logLatency(reply);
		if (this.#reply === reply) this.#reply = undefined;
		this.#maybeTellReport();
	}

	// 人に聞こえ得た返事だけを残す。確定前に捨てた先行生成は誰も聞いていない。
	#recordSaid(reply: Reply, spoken: Spoken): void {
		if (reply.recorded || !reply.speech.released) return;
		reply.recorded = true;
		if (spoken.played.length === 0 && spoken.cut == null && spoken.dropped.length === 0) return;
		this.#record.add({ kind: "said", at: this.dependencies.clock(), ...spoken });
	}

	#logLatency(reply: Reply): void {
		const turn = reply.turn;
		if (turn === undefined || reply.committedAt === undefined) return;
		const timings = reply.speech.timings;
		this.dependencies.logger.info("voice.turn.latency", {
			userId: turn.userId,
			pregenerated: reply.pregenerated,
			sttMs: turn.sttMs,
			speechEndToCommitMs: elapsed(turn.speechEndedAt, reply.committedAt),
			firstTextMs: elapsed(reply.startedAt, reply.firstTextAt),
			firstAudioMs: elapsed(reply.startedAt, timings.firstSynthesizedAt),
			speechEndToVoiceMs: elapsed(turn.speechEndedAt, timings.firstPlayedAt),
		});
	}

	#maybeTellReport(): void {
		if (
			!this.#unreadReport ||
			this.#closed ||
			this.#reply !== undefined ||
			!this.turns.idle ||
			this.#speaking.size > 0 ||
			this.#judge.judging
		) {
			return;
		}
		this.#unreadReport = false;
		this.#startReply({ kind: "report" }, undefined, true);
	}
}

function elapsed(from: number, to: number | undefined): number | undefined {
	return to === undefined ? undefined : Math.round(to - from);
}
