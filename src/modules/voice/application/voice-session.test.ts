import { afterEach, describe, expect, it, vi } from "vitest";

import { createRecordingLogger } from "../../observability/testing/recording-logger";
import type { VoiceRecordEntry } from "../domain/voice-record";
import type { InterruptClassifierPort } from "../ports/interrupt-classifier-port";
import {
	createFakeFront,
	createFakePlayback,
	createFakeVoices,
	flush,
	textSynthesizer,
} from "../testing/fake-voice";
import { SpeechOutput } from "./speech-output";
import { TurnTracker } from "./turn-tracker";
import type { Turn } from "./turn-tracker";
import { VoiceResponder } from "./voice-responder";
import { VoiceSession } from "./voice-session";

const SPEAKERS = new Map([
	["42", "シュン"],
	["7", "ユウ"],
]);
const AT = new Date(2026, 10, 19, 12, 0, 0);
const TURN_WAIT_MS = 800;

function setup() {
	vi.useFakeTimers();
	const logger = createRecordingLogger();
	const voices = createFakeVoices();
	const front = createFakeFront();
	const playback = createFakePlayback();
	const classifier = {
		classify: vi.fn<InterruptClassifierPort["classify"]>(async () => "interruption"),
	};
	const ongoing = new Map<string, Float32Array>();
	const delegated: Array<Readonly<{ request: string; transcript: readonly VoiceRecordEntry[] }>> =
		[];
	const hear = vi.fn<(turn: Turn) => boolean>(() => false);
	const speakerName = async (userId: string): Promise<string> => SPEAKERS.get(userId) ?? userId;
	const handlers: { session?: VoiceSession } = {};
	const turns = new TurnTracker(
		{
			transcriber: voices.transcriber,
			speakerName,
			logger,
			now: () => Date.now(),
			silenceMs: 500,
			turnWaitMs: TURN_WAIT_MS,
			unfinishedTurnWaitMs: 2000,
		},
		{
			onDraft: (turn) => handlers.session?.draft(turn),
			onCommit: (turn) => handlers.session?.commit(turn),
			onDiscard: () => handlers.session?.discard(),
		},
	);
	const session = new VoiceSession(
		{
			responder: new VoiceResponder(front.stream, logger),
			output: new SpeechOutput({
				synthesizer: textSynthesizer,
				playback,
				logger,
				now: () => Date.now(),
			}),
			transcriber: voices.transcriber,
			classifier,
			ongoingSpeech: (userId) => ongoing.get(userId),
			speakerName,
			back: {
				delegate: (request, transcript) => {
					delegated.push({ request, transcript });
					return true;
				},
				hear,
			},
			logger,
			now: () => Date.now(),
			clock: () => AT,
		},
		turns,
	);
	handlers.session = session;

	// 声を検知してから区切れるまで。
	const speak = async (userId: string, text: string): Promise<void> => {
		session.speechStarted(userId);
		session.segment(userId, voices.voice(text));
		await flush();
	};
	const commitTurn = async (): Promise<void> => {
		await vi.advanceTimersByTimeAsync(TURN_WAIT_MS);
		await flush();
	};
	const finishPlaying = async (): Promise<void> => {
		playback.finishPlaying();
		await flush();
	};
	const events = () => logger.entries.map((entry) => entry.event);
	return {
		session,
		front,
		playback,
		classifier,
		voices,
		ongoing,
		delegated,
		hear,
		logger,
		speak,
		commitTurn,
		finishPlaying,
		events,
	};
}

const call = (front: ReturnType<typeof createFakeFront>, index: number) => {
	const found = front.calls[index];
	if (found === undefined) throw new Error(`front was not asked ${String(index + 1)} times`);
	return found;
};

const heard = (userId: string, text: string): VoiceRecordEntry => ({
	kind: "heard",
	at: AT,
	userId,
	speaker: SPEAKERS.get(userId) ?? userId,
	text,
	aside: null,
});

// シュンの1ターンに「一文目。二文目。三文目。」と返し始め、二文目を再生している所まで進める。三文目は続きが届くまで表から出てこない。
async function speakingSecondSentence(context: ReturnType<typeof setup>) {
	await context.speak("42", "ルナ、昔話をお願い");
	call(context.front, 0).say("一文目。二文目。三文目。");
	await context.commitTurn();
	await context.finishPlaying();
	expect(context.playback.plays.map((play) => play.text)).toEqual(["一文目。", "二文目。"]);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("VoiceSession", () => {
	describe("ターンへの返事", () => {
		it("区切りの時点で表に返事を作らせ始め、ターンが確定してから再生する", async () => {
			const { front, playback, speak, finishPlaying } = setup();

			await speak("42", "ルナ、こんにちは");

			const first = call(front, 0);
			expect(first.recordLines()).toEqual(["[12:00:00] シュン: ルナ、こんにちは"]);
			expect(first.prompt).toMatch(/シュン just finished speaking\. .*$/u);
			first.say("こんにちは。元気");
			first.say("？");
			first.end();
			await flush();
			await vi.advanceTimersByTimeAsync(TURN_WAIT_MS - 1);
			expect(playback.plays).toEqual([]);

			await vi.advanceTimersByTimeAsync(1);
			await flush();
			expect(playback.plays.map((play) => play.text)).toEqual(["こんにちは。"]);
			await finishPlaying();
			expect(playback.plays.map((play) => play.text)).toEqual(["こんにちは。", "元気？"]);
		});

		it("再生し終えた返事を会話記録に残し、次の返事の材料にする", async () => {
			const { front, speak, commitTurn, finishPlaying, events } = setup();
			await speak("42", "ルナ、こんにちは");
			call(front, 0).say("こんにちは。");
			call(front, 0).end();
			await commitTurn();
			await finishPlaying();

			await speak("42", "元気だよ");

			expect(call(front, 1).recordLines()).toEqual([
				"[12:00:00] シュン: ルナ、こんにちは",
				"[12:00:00] You: こんにちは。",
				"[12:00:00] シュン: 元気だよ",
			]);
			expect(events()).toContain("voice.turn.latency");
		});

		it("確定前に同じ話者の続きが来たら作りかけを捨て、つなげた発話で作り直す", async () => {
			const { session, front, playback, delegated, voices, speak, commitTurn, finishPlaying } =
				setup();
			await speak("42", "ルナ");
			const discarded = call(front, 0);
			discarded.say("なに？");
			discarded.delegate("捨てた返事の依頼");
			await flush();

			session.speechStarted("42");
			session.segment("42", voices.voice("明日の天気は"));
			await flush();

			expect(discarded.signal.aborted).toBe(true);
			const remade = call(front, 1);
			expect(remade.recordLines()).toEqual(["[12:00:00] シュン: ルナ明日の天気は"]);
			remade.say("晴れだよ。");
			remade.end();
			await commitTurn();
			await finishPlaying();
			expect(playback.plays.map((play) => play.text)).toEqual(["晴れだよ。"]);
			expect(delegated).toEqual([]);

			await speak("42", "ありがとう");
			expect(call(front, 2).recordLines()).toEqual([
				"[12:00:00] シュン: ルナ明日の天気は",
				"[12:00:00] You: 晴れだよ。",
				"[12:00:00] シュン: ありがとう",
			]);
		});

		it("確定前に別の話者の発話が来たら、作りかけを捨ててその人への返事を作り始める", async () => {
			const { front, playback, speak } = setup();
			await speak("42", "ねえルナ");
			call(front, 0).say("なに？");

			await speak("7", "今日さ");

			expect(call(front, 0).signal.aborted).toBe(true);
			expect(call(front, 1).prompt).toContain("ユウ just finished speaking.");
			expect(playback.plays).toEqual([]);
		});

		it("先行生成が何も言わずに終わったら、確定しても表に頼み直さず黙る", async () => {
			const { session, front, playback, speak, commitTurn } = setup();
			await speak("42", "それでさ、昨日");
			call(front, 0).end();
			await commitTurn();

			expect(front.calls).toHaveLength(1);
			expect(playback.plays).toEqual([]);

			session.report("昨日の件は調べた");
			await flush();
			expect(call(front, 1).prompt).toContain("A new backstage report arrived");
		});

		it("表が途中で失敗したら、それまでに出た文だけを再生してログに残す", async () => {
			const { front, playback, speak, commitTurn, finishPlaying, logger } = setup();
			await speak("42", "ルナ、こんにちは");
			call(front, 0).say("えっと。それは");
			call(front, 0).fail(new Error("upstream 500"));
			await commitTurn();
			await finishPlaying();

			expect(playback.plays.map((play) => play.text)).toEqual(["えっと。"]);
			expect(logger.entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ level: "error", event: "voice.front.failed" }),
					expect.objectContaining({
						event: "voice.front.responded",
						details: expect.objectContaining({ failed: true, pregenerated: true }),
					}),
				]),
			);
		});

		it("先行生成で表が何も言わずに失敗しても、確定時に頼み直さない", async () => {
			const { front, playback, speak, commitTurn } = setup();
			await speak("42", "ルナ、こんにちは");
			call(front, 0).fail(new Error("timeout"));
			await commitTurn();

			expect(front.calls).toHaveLength(1);
			expect(playback.plays).toEqual([]);
		});
	});

	describe("裏への依頼", () => {
		it("確定前に表が出した依頼は、確定してから裏へまだ渡していない会話記録と一緒に渡す", async () => {
			const { front, delegated, speak, commitTurn, finishPlaying } = setup();
			await speak("42", "明日の天気わかる？");
			call(front, 0).say("調べるね。");
			call(front, 0).delegate("明日の東京の天気");
			call(front, 0).end();
			await flush();
			expect(delegated).toEqual([]);

			await commitTurn();
			expect(delegated).toEqual([
				{ request: "明日の東京の天気", transcript: [heard("42", "明日の天気わかる？")] },
			]);
			await finishPlaying();

			await speak("42", "傘はいる？");
			call(front, 1).delegate("明日の東京で傘が要るか");
			await commitTurn();

			expect(delegated[1]).toEqual({
				request: "明日の東京で傘が要るか",
				transcript: [
					{ kind: "said", at: AT, played: ["調べるね。"], cut: null, dropped: [] },
					heard("42", "傘はいる？"),
				],
			});
		});

		it("確定した後に表が出した依頼は、すぐに裏へ渡す", async () => {
			const { front, delegated, speak, commitTurn } = setup();
			await speak("42", "電気を消してほしい");
			await commitTurn();

			call(front, 0).delegate("リビングの電気を消す");
			await flush();

			expect(delegated.map((entry) => entry.request)).toEqual(["リビングの電気を消す"]);
		});

		it("先行生成が依頼だけを出して終わっても、確定したら裏へ渡す", async () => {
			const { front, delegated, speak, commitTurn } = setup();
			await speak("42", "電気を消してほしい");
			call(front, 0).delegate("リビングの電気を消す");
			call(front, 0).end();
			await commitTurn();

			expect(delegated.map((entry) => entry.request)).toEqual(["リビングの電気を消す"]);
			expect(front.calls).toHaveLength(1);
		});

		it("表の知らないツール呼び出しや空の依頼は、裏へ渡さずログに残す", async () => {
			const { front, delegated, speak, commitTurn, logger } = setup();
			await speak("42", "調べて");
			await commitTurn();

			call(front, 0).toolCall("web_search", { query: "天気" });
			call(front, 0).toolCall("delegate", { request: "  " });
			call(front, 0).toolCall("delegate", "明日の天気");
			call(front, 0).end();
			await flush();

			expect(delegated).toEqual([]);
			expect(
				logger.entries.filter((entry) => entry.event === "voice.front.invalid_tool_call"),
			).toHaveLength(3);
		});

		it("確定した発話を裏が受け取ったら、閉じる時の会話記録に重ねて入れない", async () => {
			const { session, front, hear, speak, commitTurn } = setup();
			await speak("42", "電気を消してほしい");
			call(front, 0).delegate("リビングの電気を消す");
			call(front, 0).end();
			await commitTurn();

			hear.mockReturnValue(true);
			await speak("42", "寝室もお願い");
			call(front, 1).end();
			await commitTurn();

			expect(hear).toHaveBeenLastCalledWith(
				expect.objectContaining({ userId: "42", speaker: "シュン", text: "寝室もお願い" }),
			);
			await expect(session.close()).resolves.toEqual([]);
		});
	});

	describe("読み上げ中に聞こえた声", () => {
		it("割り込みなら再生と表の要求を止め、言えた所を残して、その声を次のターンにする", async () => {
			const context = setup();
			const { session, front, playback, classifier, voices, commitTurn, logger } = context;
			await speakingSecondSentence(context);
			call(front, 0).say("四文目");
			await flush();

			session.speechStarted("7");
			expect(playback.volumes).toEqual([0.3]);
			session.segment("7", voices.voice("ちょっと待った"));
			await flush();

			expect(classifier.classify).toHaveBeenCalledWith(
				{ heard: "ちょっと待った", lunaSaying: "二文目。" },
				expect.any(AbortSignal),
			);
			expect(playback.stops()).toBe(1);
			await expect(playback.plays[1]?.done.promise).resolves.toBe(false);
			expect(call(front, 0).signal.aborted).toBe(true);
			expect(playback.volumes.at(-1)).toBe(1);
			expect(logger.entries).toContainEqual(
				expect.objectContaining({
					event: "voice.speech.interrupted",
					details: { userId: "7", played: ["一文目。"], cut: "二文目。", dropped: ["三文目。"] },
				}),
			);
			expect(call(front, 1).recordLines()).toEqual([
				"[12:00:00] シュン: ルナ、昔話をお願い",
				"[12:00:00] You: 一文目。 [cut off while saying: 二文目。] [did not get to say: 三文目。]",
				"[12:00:00] ユウ: ちょっと待った",
			]);

			call(front, 1).say("どうしたの？");
			call(front, 1).end();
			await commitTurn();
			expect(playback.plays.at(-1)?.text).toBe("どうしたの？");
		});

		it.each([
			["backchannel", "ユウ (while you were speaking, a backchannel): うんうん"],
			["not_to_luna", "ユウ (while you were speaking, not to you): うんうん"],
		] as const)("%s なら止めずに音量を戻し、会話記録にだけ残す", async (verdict, line) => {
			const context = setup();
			const { session, front, playback, classifier, voices, speak, finishPlaying } = context;
			classifier.classify.mockResolvedValue(verdict);
			await speakingSecondSentence(context);

			session.speechStarted("7");
			session.segment("7", voices.voice("うんうん"));
			await flush();

			expect(playback.stops()).toBe(0);
			expect(playback.volumes).toEqual([0.3, 1]);
			expect(front.calls).toHaveLength(1);
			await finishPlaying();
			call(front, 0).end();
			await flush();
			await finishPlaying();

			await speak("42", "続きは？");
			expect(call(front, 1).recordLines()).toEqual([
				"[12:00:00] シュン: ルナ、昔話をお願い",
				`[12:00:00] ${line}`,
				"[12:00:00] You: 一文目。二文目。三文目。",
				"[12:00:00] シュン: 続きは？",
			]);
		});

		it("声以外の音なら判定にかけず、何も残さずに音量を戻す", async () => {
			const context = setup();
			const { session, front, playback, classifier, voices } = context;
			await speakingSecondSentence(context);

			session.speechStarted("7");
			session.segment("7", voices.voice("", { nonVerbal: true }));
			await flush();

			expect(classifier.classify).not.toHaveBeenCalled();
			expect(playback.stops()).toBe(0);
			expect(playback.volumes).toEqual([0.3, 1]);
			expect(front.calls).toHaveLength(1);
		});

		it("判定に失敗したら割り込みとみなして止める", async () => {
			const context = setup();
			const { session, playback, classifier, voices, events } = context;
			classifier.classify.mockRejectedValue(new Error("timeout"));
			await speakingSecondSentence(context);

			session.speechStarted("7");
			session.segment("7", voices.voice("あのさ"));
			await flush();

			expect(playback.stops()).toBe(1);
			expect(events()).toEqual(
				expect.arrayContaining([
					"voice.interrupt.classification_failed",
					"voice.speech.interrupted",
				]),
			);
		});

		it("声が区切れる前に1秒続いて割り込みと決まったら、区切りを待たずに止める", async () => {
			const context = setup();
			const { session, front, playback, classifier, voices, ongoing } = context;
			await speakingSecondSentence(context);
			ongoing.set("7", voices.voice("ストップストップ"));

			session.speechStarted("7");
			await vi.advanceTimersByTimeAsync(1000);
			await flush();
			expect(playback.stops()).toBe(1);

			session.segment("7", voices.voice("ストップストップ、話を聞いて"));
			await flush();
			expect(classifier.classify).toHaveBeenCalledTimes(1);
			expect(call(front, 1).recordLines().at(-1)).toBe(
				"[12:00:00] ユウ: ストップストップ、話を聞いて",
			);
		});
	});

	describe("裏の報告", () => {
		it("誰も話しておらず表も話していなければ、すぐ表に伝えさせる", async () => {
			const { session, front, playback } = setup();

			session.report("明日の東京は晴れ");
			await flush();

			const told = call(front, 0);
			expect(told.recordLines()).toEqual(["[12:00:00] Backstage report: 明日の東京は晴れ"]);
			expect(told.prompt).toMatch(/A new backstage report arrived and nobody is talking\./u);
			told.say("明日は晴れだって。");
			told.end();
			await flush();
			expect(playback.plays.map((play) => play.text)).toEqual(["明日は晴れだって。"]);
		});

		it("人が話している間は伝えず、続きがないと分かってから伝える", async () => {
			const { session, front, voices } = setup();
			session.speechStarted("42");

			session.report("明日の東京は晴れ");
			await flush();
			expect(front.calls).toEqual([]);

			session.segment("42", voices.voice("", { nonVerbal: true }));
			await flush();
			expect(call(front, 0).prompt).toContain("A new backstage report arrived");
		});

		it("表が話している間に届いた報告は、話し終えてから伝える", async () => {
			const { session, front, speak, commitTurn, finishPlaying } = setup();
			await speak("42", "ルナ、こんにちは");
			call(front, 0).say("こんにちは。");
			call(front, 0).end();
			await commitTurn();

			session.report("頼まれた件が終わった");
			await flush();
			expect(front.calls).toHaveLength(1);

			await finishPlaying();
			expect(call(front, 1).prompt).toContain("A new backstage report arrived");
			expect(call(front, 1).recordLines()).toContain(
				"[12:00:00] Backstage report: 頼まれた件が終わった",
			);
		});
	});

	describe("閉じる", () => {
		it("読み上げと表の要求を止め、裏へまだ渡していない会話記録を返す", async () => {
			const { session, front, playback, speak, commitTurn } = setup();
			await speak("42", "ルナ、こんにちは");
			call(front, 0).say("こんにちは。今日は");
			await commitTurn();

			const transcript = await session.close();

			expect(transcript).toEqual([
				heard("42", "ルナ、こんにちは"),
				{ kind: "said", at: AT, played: [], cut: "こんにちは。", dropped: [] },
			]);
			expect(call(front, 0).signal.aborted).toBe(true);
			expect(front.closed()).toBe(true);
			expect(playback.stops()).toBe(1);
			expect(playback.volumes.at(-1)).toBe(1);
		});

		it("人の声もエージェントの声もなければ、会話記録を返さない", async () => {
			const { session, front } = setup();
			session.report("明日の東京は晴れ");
			await flush();
			call(front, 0).end();
			await flush();

			await expect(session.close()).resolves.toEqual([]);
		});

		it("閉じた後の声は聞き取らず、報告も伝えない", async () => {
			const { session, front, voices } = setup();
			await session.close();

			session.speechStarted("42");
			session.segment("42", voices.voice("ルナ？"));
			session.report("明日の東京は晴れ");
			await vi.advanceTimersByTimeAsync(TURN_WAIT_MS);

			expect(voices.transcriber.transcribe).not.toHaveBeenCalled();
			expect(front.calls).toEqual([]);
		});
	});
});
