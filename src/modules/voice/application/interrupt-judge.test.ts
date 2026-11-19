import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecordingLogger } from "../../observability/testing/recording-logger";
import type { InterruptQuestion, InterruptVerdict } from "../ports/interrupt-classifier-port";
import type { Transcription } from "../ports/transcriber-port";
import { InterruptJudge } from "./interrupt-judge";

const EARLY_CHECK_MS = 1000;

const heard = (text: string, nonVerbal = false): Transcription => ({
	text,
	nonVerbal,
	elapsedMs: 80,
});
const ONGOING = Float32Array.from([0.1]);
const SEGMENT = Float32Array.from([0.1, 0.2]);

function setup() {
	const logger = createRecordingLogger();
	const transcribe = vi.fn<(samples: Float32Array) => Promise<Transcription>>();
	const classify =
		vi.fn<(question: InterruptQuestion, signal: AbortSignal) => Promise<InterruptVerdict>>();
	const ongoingSpeech = vi.fn<(userId: string) => Float32Array | undefined>(() => ONGOING);
	const interruptions: string[] = [];
	const judge = new InterruptJudge(
		{
			transcriber: { transcribe },
			classifier: { classify },
			ongoingSpeech,
			logger,
			now: () => Date.now(),
			earlyCheckMs: EARLY_CHECK_MS,
		},
		{ onInterruption: (userId) => interruptions.push(userId) },
	);
	return { judge, transcribe, classify, ongoingSpeech, logger, interruptions };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("InterruptJudge", () => {
	it.each([
		["空の文字起こし", heard("")],
		["声以外の音", heard("(咳)", true)],
	])("区切れた声が%sなら雑音として扱い、判定にかけない", async (_, result) => {
		const { judge, transcribe, classify, interruptions } = setup();
		transcribe.mockResolvedValueOnce(result);

		judge.start("1", "今日は晴れです。");
		const hearing = await judge.end("1", SEGMENT);

		expect(hearing).toEqual({ kind: "noise" });
		expect(transcribe).toHaveBeenCalledWith(SEGMENT);
		expect(classify).not.toHaveBeenCalled();
		expect(interruptions).toEqual([]);
		expect(judge.judging).toBe(false);
	});

	it.each(["backchannel", "not_to_luna"] as const)(
		"%s と判定された声は止まらずに、認識した文字と扱いを返す",
		async (verdict) => {
			const { judge, transcribe, classify, interruptions, logger } = setup();
			transcribe.mockResolvedValueOnce(heard("うんうん"));
			classify.mockResolvedValueOnce(verdict);

			judge.start("1", "今日は晴れです。");
			const hearing = await judge.end("1", SEGMENT);

			expect(hearing).toEqual({ kind: "aside", aside: verdict, text: "うんうん" });
			expect(classify).toHaveBeenCalledWith(
				{ heard: "うんうん", lunaSaying: "今日は晴れです。" },
				expect.any(AbortSignal),
			);
			expect(interruptions).toEqual([]);
			expect(logger.entries).toContainEqual(
				expect.objectContaining({
					event: "voice.interrupt.judged",
					details: expect.objectContaining({ userId: "1", stage: "final", verdict }),
				}),
			);
		},
	);

	it("割り込みと判定されたら onInterruption を1度呼び、割り込みを返す", async () => {
		const { judge, transcribe, classify, interruptions } = setup();
		transcribe.mockResolvedValueOnce(heard("ちょっと待って"));
		classify.mockResolvedValueOnce("interruption");

		judge.start("1", "今日は晴れです。");

		await expect(judge.end("1", SEGMENT)).resolves.toEqual({ kind: "interruption" });
		expect(interruptions).toEqual(["1"]);
		expect(judge.isJudging("1")).toBe(false);
	});

	it("判定に失敗したら、ログに残して割り込みとして扱う", async () => {
		const { judge, transcribe, classify, interruptions, logger } = setup();
		transcribe.mockResolvedValueOnce(heard("ねえ"));
		classify.mockRejectedValueOnce(new Error("timeout"));

		judge.start("1", "今日は晴れです。");

		await expect(judge.end("1", SEGMENT)).resolves.toEqual({ kind: "interruption" });
		expect(interruptions).toEqual(["1"]);
		expect(logger.entries).toContainEqual(
			expect.objectContaining({ level: "error", event: "voice.interrupt.classification_failed" }),
		);
	});

	it("認識に失敗したら、判定にかけずに割り込みとして扱う", async () => {
		const { judge, transcribe, classify, interruptions, logger } = setup();
		transcribe.mockRejectedValueOnce(new Error("stt down"));

		judge.start("1", "今日は晴れです。");

		await expect(judge.end("1", SEGMENT)).resolves.toEqual({ kind: "interruption" });
		expect(classify).not.toHaveBeenCalled();
		expect(interruptions).toEqual(["1"]);
		expect(logger.entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				event: "voice.interrupt.transcription_failed",
				details: expect.objectContaining({ stage: "final" }),
			}),
		);
	});

	it("判定を始めていない話者の声は雑音として扱う", async () => {
		const { judge, transcribe } = setup();

		await expect(judge.end("1", SEGMENT)).resolves.toEqual({ kind: "noise" });
		expect(transcribe).not.toHaveBeenCalled();
	});

	it("判定中の話者の start は無視し、最初に読み上げていた文で判定する", async () => {
		const { judge, transcribe, classify } = setup();
		transcribe.mockResolvedValueOnce(heard("うん"));
		classify.mockResolvedValueOnce("backchannel");

		judge.start("1", "一文目。");
		judge.start("1", "二文目。");
		await judge.end("1", SEGMENT);

		expect(classify).toHaveBeenCalledWith(
			{ heard: "うん", lunaSaying: "一文目。" },
			expect.any(AbortSignal),
		);
	});

	it("earlyCheckMs 続いた声はその時点までの音声で判定し、割り込みならその場で止める", async () => {
		const { judge, transcribe, classify, ongoingSpeech, interruptions } = setup();
		transcribe.mockResolvedValueOnce(heard("ちょっと待って"));
		classify.mockResolvedValueOnce("interruption");

		judge.start("1", "今日は晴れです。");
		await vi.advanceTimersByTimeAsync(EARLY_CHECK_MS - 1);
		expect(ongoingSpeech).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect(ongoingSpeech).toHaveBeenCalledWith("1");
		expect(transcribe).toHaveBeenCalledWith(ONGOING);
		expect(interruptions).toEqual(["1"]);
		await expect(judge.end("1", SEGMENT)).resolves.toEqual({ kind: "interruption" });
		expect(transcribe).toHaveBeenCalledTimes(1);
		expect(interruptions).toEqual(["1"]);
	});

	it("区切れる前の認識に失敗したら、その場で割り込みとして扱う", async () => {
		const { judge, transcribe, interruptions, logger } = setup();
		transcribe.mockRejectedValueOnce(new Error("stt down"));

		judge.start("1", "今日は晴れです。");
		await vi.advanceTimersByTimeAsync(EARLY_CHECK_MS);

		expect(interruptions).toEqual(["1"]);
		expect(logger.entries).toContainEqual(
			expect.objectContaining({
				event: "voice.interrupt.transcription_failed",
				details: expect.objectContaining({ stage: "early" }),
			}),
		);
	});

	it("受信した音声がまだなければ、区切れる前の判定はしない", async () => {
		const { judge, transcribe, ongoingSpeech } = setup();
		ongoingSpeech.mockReturnValue(undefined);

		judge.start("1", "今日は晴れです。");
		await vi.advanceTimersByTimeAsync(EARLY_CHECK_MS * 5);

		expect(transcribe).not.toHaveBeenCalled();
	});

	it("区切れる前の判定が相づちなら止めず、区切れた声で改めて判定する", async () => {
		const { judge, transcribe, classify, interruptions } = setup();
		transcribe
			.mockResolvedValueOnce(heard("うん"))
			.mockResolvedValueOnce(heard("うん、ちょっと待って"));
		classify.mockResolvedValueOnce("backchannel").mockResolvedValueOnce("interruption");

		judge.start("1", "今日は晴れです。");
		await vi.advanceTimersByTimeAsync(EARLY_CHECK_MS);
		expect(interruptions).toEqual([]);

		await expect(judge.end("1", SEGMENT)).resolves.toEqual({ kind: "interruption" });
		expect(transcribe).toHaveBeenLastCalledWith(SEGMENT);
		expect(interruptions).toEqual(["1"]);
	});

	it("区切れた後に返った区切れる前の判定は、決まった扱いを覆さない", async () => {
		const { judge, transcribe, classify, interruptions } = setup();
		const earlyVerdict = Promise.withResolvers<InterruptVerdict>();
		let earlySignal: AbortSignal | undefined;
		transcribe.mockResolvedValueOnce(heard("ちょっと")).mockResolvedValueOnce(heard("うん"));
		classify
			.mockImplementationOnce((_, signal) => {
				earlySignal = signal;
				return earlyVerdict.promise;
			})
			.mockResolvedValueOnce("backchannel");

		judge.start("1", "今日は晴れです。");
		await vi.advanceTimersByTimeAsync(EARLY_CHECK_MS);
		const hearing = await judge.end("1", SEGMENT);
		earlyVerdict.resolve("interruption");
		await vi.advanceTimersByTimeAsync(0);

		expect(hearing).toEqual({ kind: "aside", aside: "backchannel", text: "うん" });
		expect(earlySignal?.aborted).toBe(true);
		expect(interruptions).toEqual([]);
	});

	it("区切れた後に返った区切れる前の認識は、判定にかけない", async () => {
		const { judge, transcribe, classify, interruptions } = setup();
		const earlyTranscription = Promise.withResolvers<Transcription>();
		transcribe.mockReturnValueOnce(earlyTranscription.promise).mockResolvedValueOnce(heard("うん"));
		classify.mockResolvedValueOnce("backchannel");

		judge.start("1", "今日は晴れです。");
		await vi.advanceTimersByTimeAsync(EARLY_CHECK_MS);
		await judge.end("1", SEGMENT);
		earlyTranscription.resolve(heard("止まって"));
		await vi.advanceTimersByTimeAsync(0);

		expect(classify).toHaveBeenCalledTimes(1);
		expect(interruptions).toEqual([]);
	});

	it("区切れた声の判定中に区切れる前の判定が割り込みと決まれば、割り込みを返す", async () => {
		const { judge, transcribe, classify, interruptions } = setup();
		const earlyVerdict = Promise.withResolvers<InterruptVerdict>();
		transcribe
			.mockResolvedValueOnce(heard("ちょっと"))
			.mockResolvedValueOnce(heard("ちょっと待って"));
		classify.mockReturnValueOnce(earlyVerdict.promise).mockResolvedValueOnce("backchannel");

		judge.start("1", "今日は晴れです。");
		await vi.advanceTimersByTimeAsync(EARLY_CHECK_MS);
		const ending = judge.end("1", SEGMENT);
		earlyVerdict.resolve("interruption");

		await expect(ending).resolves.toEqual({ kind: "interruption" });
		expect(interruptions).toEqual(["1"]);
	});

	it("cancelAll で区切れる前の判定を取りやめ、進行中の判定を中断して割り込みにしない", async () => {
		const { judge, transcribe, classify, ongoingSpeech, interruptions } = setup();
		const signals: AbortSignal[] = [];
		const verdict = Promise.withResolvers<InterruptVerdict>();
		transcribe.mockResolvedValue(heard("ちょっと"));
		classify.mockImplementation((_, signal) => {
			signals.push(signal);
			return verdict.promise;
		});

		judge.start("1", "今日は晴れです。");
		judge.start("2", "今日は晴れです。");
		await vi.advanceTimersByTimeAsync(EARLY_CHECK_MS - 500);
		judge.start("3", "今日は晴れです。");
		await vi.advanceTimersByTimeAsync(500);
		judge.cancelAll();
		verdict.resolve("interruption");
		await vi.advanceTimersByTimeAsync(EARLY_CHECK_MS);

		expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
		expect(ongoingSpeech.mock.calls).toEqual([["1"], ["2"]]);
		expect(interruptions).toEqual([]);
		expect(judge.judging).toBe(false);
		await expect(judge.end("1", SEGMENT)).resolves.toEqual({ kind: "noise" });
	});
});
